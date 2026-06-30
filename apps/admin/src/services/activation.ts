// Campaign activation/deactivation. Phase 3c Stage C3: ACTIVATE is the side-effecting hub with an
// atomic confirm-and-replace SWAP. It provisions the shared qualifying scope and EAGER-MINTS every
// per-tier BXGY code (bounded-parallel, window-bounded with endsAt) BEFORE the swap, then flips
// activation in ONE transaction (setActiveExclusive: deactivate every other active campaign + activate
// this one) so the DB is never 0-active or 2-active. Replacing a live campaign requires confirmation
// (ReplaceConfirmationRequiredError unless options.confirmReplace). The replaced campaign's codes are
// TORN DOWN (deleted) post-commit. "Start now": a future startsAt is overridden to now (no
// auto-transition, so activation = serve now until endsAt). Ownership is checked here. Pure over the
// ports + injected gateway/mapping store — unit-tested with fakes.
import { resolvedGiftSetHash, type Gift, type Money } from '@free-gift-engine/core';
import type { DiscountCombinesWith } from '@free-gift-engine/shopify';
import { assertCampaignInputValid } from '../admin/campaignValidation.js';
import type { CampaignInputDTO, CampaignResponse } from '../contract.js';
import type { Campaign, MintingKey } from '../domain.js';
import type { CampaignRepository, GiftVariantGateway } from '../ports.js';
import type { GiftCodeMappingStore, GiftDiscountSpec } from '../store/giftCodeMapping.js';
import { GIFT_COMBINES_WITH } from '../validate/service.js';
import {
  assertVariantsLive,
  campaignToResponse,
  toConfigVersionHash,
  toNewCampaignInput,
} from './campaign.js';
import { provisionGifts, type GiftTagGateway } from './giftLifecycle.js';

// Bounded concurrency for eager-minting (~14 codes / 5 in flight ≈ 3 waves). Tunable.
const MINT_CONCURRENCY = 5;

// Thrown when activating B would replace a DIFFERENT active campaign A and the caller has not
// confirmed. The route maps it to a 409 with requiresConfirmation so the UI shows a confirm dialog;
// re-calling with confirmReplace=true performs the swap. No side effects when thrown.
export class ReplaceConfirmationRequiredError extends Error {
  constructor(
    readonly activeId: string,
    readonly activeName: string,
  ) {
    super(`Replace the active campaign "${activeName}"? It will stop offering its gift.`);
    this.name = 'ReplaceConfirmationRequiredError';
  }
}

// Thrown when activating a campaign that has no qualifying collection configured. The merchant must
// set a qualifying collection in the admin before activating. Mapped to 400.
export class MissingQualifyingCollectionError extends Error {
  constructor(readonly campaignId: string) {
    super('Campaign requires a qualifying collection before activation.');
    this.name = 'MissingQualifyingCollectionError';
  }
}

// Thrown when activating a campaign whose window has already ended (endsAt <= now) — it could never
// serve. The route maps it to a 400.
export class ActivationWindowError extends Error {
  constructor(readonly endsAt: Date) {
    super(`Campaign window has already ended (${endsAt.toISOString()}); cannot activate.`);
    this.name = 'ActivationWindowError';
  }
}

export type MintFailure = {
  readonly position: number;
  readonly variantIds: readonly string[];
  readonly message: string;
};

// Thrown when one or more per-tier codes fail to mint at activate. Names the failing tiers + variants
// so the merchant sees WHICH gift is the problem (the campaign stays inactive). Mapped to 400.
export class ActivationMintError extends Error {
  constructor(readonly failures: readonly MintFailure[]) {
    super(
      `Could not mint ${failures.length} gift code(s): ` +
        failures
          .map((f) => `tier ${f.position} [${f.variantIds.join(', ')}]: ${f.message}`)
          .join('; '),
    );
    this.name = 'ActivationMintError';
  }
}

export type ActivationDeps = {
  readonly campaignRepo: CampaignRepository;
  readonly gateway: GiftTagGateway;
  readonly mappingStore: GiftCodeMappingStore;
  // The model-C flag (gifts INCLUDED in the qualifying collection); drives provisioning + the mint guard.
  readonly giftsIncluded: boolean;
  readonly now: () => Date;
  readonly combinesWith?: DiscountCombinesWith;
};

export type ActivateOptions = { readonly confirmReplace?: boolean };

type MintTarget = {
  readonly position: number;
  readonly gifts: readonly Gift[];
  readonly minimumSubtotal: Money;
};

// One reusable code per resolved gift-set: AND -> one set; OR -> one per option. Mirrors /validate.
function mintTargets(campaign: Campaign): MintTarget[] {
  return campaign.tiers.flatMap((tier) => {
    const base = { position: tier.position, minimumSubtotal: tier.baseThreshold };
    return tier.gift.kind === 'AND'
      ? [{ ...base, gifts: tier.gift.gifts }]
      : tier.gift.options.map((o) => ({ ...base, gifts: [{ variantId: o.variantId }] }));
  });
}

function allGiftVariantIds(campaign: Campaign): string[] {
  const ids = new Set<string>();
  for (const tier of campaign.tiers) {
    if (tier.gift.kind === 'AND') {
      for (const g of tier.gift.gifts) ids.add(g.variantId);
    } else {
      for (const o of tier.gift.options) ids.add(o.variantId);
    }
  }
  return [...ids];
}

// Run `fn` over items with at most `limit` in flight; settle ALL (never short-circuit).
async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i] as T;
      try {
        results[i] = { status: 'fulfilled', value: await fn(item) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// Eager-mint every per-tier code with the campaign's window [startsAt, endsAt]. `startsAt` is the
// effective (possibly start-now-overridden) instant. Throws ActivationMintError naming any failures.
async function eagerMint(
  campaign: Campaign,
  collectionId: string,
  startsAt: Date,
  deps: ActivationDeps,
): Promise<void> {
  const targets = mintTargets(campaign);
  const startsAtIso = startsAt.toISOString();
  const endsAtIso = campaign.endsAt.toISOString();
  const combinesWith = deps.combinesWith ?? GIFT_COMBINES_WITH;

  const settled = await runBounded(targets, MINT_CONCURRENCY, (t) => {
    const key: MintingKey = {
      campaignId: campaign.id,
      tierPosition: t.position,
      resolvedGiftSetHash: resolvedGiftSetHash(t.gifts),
      configVersionHash: campaign.configVersionHash,
    };
    const spec: GiftDiscountSpec = {
      title: `${campaign.name} — tier ${t.position}`,
      giftVariantIds: t.gifts.map((g) => g.variantId),
      minimumSubtotal: t.minimumSubtotal,
      qualifyingCollectionId: collectionId,
      startsAt: startsAtIso,
      endsAt: endsAtIso,
      combinesWith,
    };
    return deps.mappingStore.getOrCreate(key, spec);
  });

  const failures: MintFailure[] = settled.flatMap((r, i) => {
    if (r.status === 'fulfilled' && r.value.code !== null) {
      return [];
    }
    const t = targets[i] as MintTarget;
    const message = r.status === 'rejected' ? messageOf(r.reason) : 'mint resolved without a code';
    return [{ position: t.position, variantIds: t.gifts.map((g) => g.variantId), message }];
  });
  if (failures.length > 0) {
    throw new ActivationMintError(failures);
  }
}

// Activate a campaign owned by `shopId`. null when not found / not owned (-> 404). Idempotent when
// already active. Throws ReplaceConfirmationRequiredError (a different campaign is active and
// confirmReplace wasn't set), ActivationWindowError (window ended), GiftProvisioningError (broken
// scope), or ActivationMintError (a code failed) — in all of which the campaign stays INACTIVE and the
// prior active campaign keeps serving. On success: provision + eager-mint, then the ATOMIC swap, then
// tear down the replaced campaign's codes (post-commit, best-effort).
export async function activateCampaign(
  shopId: string,
  campaignId: string,
  deps: ActivationDeps,
  options: ActivateOptions = {},
): Promise<CampaignResponse | null> {
  const campaign = await deps.campaignRepo.findById(campaignId);
  if (campaign === null || campaign.shopId !== shopId) {
    return null;
  }
  if (campaign.active) {
    return campaignToResponse(campaign); // already active — no-op
  }
  const now = deps.now();
  if (campaign.qualifyingCollectionId === null) {
    throw new MissingQualifyingCollectionError(campaignId);
  }
  if (campaign.endsAt.getTime() <= now.getTime()) {
    throw new ActivationWindowError(campaign.endsAt);
  }
  const prior = await deps.campaignRepo.findActiveByShop(shopId);
  const replacing = prior !== null && prior.id !== campaignId;
  if (replacing && options.confirmReplace !== true) {
    throw new ReplaceConfirmationRequiredError(prior.id, prior.name);
  }

  // Start now: a future startsAt is overridden to now (no auto-transition, so a future start would
  // only create a serving gap). endsAt is unchanged and still closes the window (Shopify expires codes).
  const startsAt = campaign.startsAt.getTime() > now.getTime() ? now : campaign.startsAt;

  // Provision + eager-mint BEFORE the swap, so a failure leaves the prior campaign active (no gap).
  await provisionGifts(deps.gateway, allGiftVariantIds(campaign), {
    giftsIncluded: deps.giftsIncluded,
  });
  await eagerMint(campaign, campaign.qualifyingCollectionId, startsAt, deps);

  // Atomic swap (commit): exactly this campaign is active afterwards.
  await deps.campaignRepo.setActiveExclusive(shopId, campaignId, startsAt);

  // Post-commit teardown of the replaced campaign's codes (best-effort; B is already serving).
  if (replacing && prior !== null) {
    await deps.mappingStore.teardownCampaign(prior.id);
  }
  return campaignToResponse({ ...campaign, active: true, startsAt });
}

// Deactivate a campaign owned by `shopId`. null when not found / not owned. Idempotent when already
// inactive. Flips active off (the lazy /validate gate stops offering) AND tears down its codes
// (deletes them so a held code stops working immediately). Touches only this campaign's codes — the
// shared collection + gift tags are untouched (model-C).
export async function deactivateCampaign(
  shopId: string,
  campaignId: string,
  deps: Pick<ActivationDeps, 'campaignRepo' | 'mappingStore'>,
): Promise<CampaignResponse | null> {
  const campaign = await deps.campaignRepo.findById(campaignId);
  if (campaign === null || campaign.shopId !== shopId) {
    return null;
  }
  if (!campaign.active) {
    return campaignToResponse(campaign); // already inactive — no-op
  }
  await deps.campaignRepo.setActive(campaignId, false);
  await deps.mappingStore.teardownCampaign(campaignId);
  return campaignToResponse({ ...campaign, active: false });
}

// --- Edit-while-active SUPERSEDE (Phase 3c Q4) ---------------------------------------------------

// Thrown when a LIVE campaign's schedule (startsAt/endsAt) is edited. The schedule is deliberately
// outside configVersionHash (so it never churns codes), and the minted codes carry endsAt — so a live
// schedule change can't be superseded gap-free. The merchant must deactivate → edit → re-activate
// (re-activation re-mints with the new window). Mapped to a 400.
export class ScheduleEditRequiresDeactivationError extends Error {
  constructor(readonly campaignId: string) {
    super('Deactivate the campaign to change its schedule, then re-activate.');
    this.name = 'ScheduleEditRequiresDeactivationError';
  }
}

export type SupersedeDeps = ActivationDeps & { readonly variantGateway: GiftVariantGateway };

function windowChanged(input: CampaignInputDTO, existing: Campaign): boolean {
  return (
    new Date(input.startsAt).getTime() !== existing.startsAt.getTime() ||
    new Date(input.endsAt).getTime() !== existing.endsAt.getTime()
  );
}

// Build an in-memory Campaign carrying the NEW config (for eager-mint, which keys on tier POSITION, not
// the DB tier id — so a placeholder id is fine). The window stays the existing one (live schedule edits
// are refused upstream), so codes mint with the campaign's current [startsAt, endsAt].
function withNewConfig(existing: Campaign, input: CampaignInputDTO, newHash: string): Campaign {
  return {
    ...existing,
    name: input.name,
    suppression: input.suppression,
    declineEnabled: input.declineEnabled,
    configVersionHash: newHash,
    tiers: input.tiers.map((t) => ({
      id: '',
      campaignId: existing.id,
      position: t.position,
      baseThreshold: t.baseThreshold,
      gift: t.gift,
      marketThresholds: [],
    })),
  };
}

// Edit a campaign owned by `shopId`. null when not found / not owned (-> 404). For an INACTIVE draft
// it's a plain persist (codes are minted at activate). For a LIVE campaign it SUPERSEDES, gap-free:
// validate → if the SCOPE (configVersionHash) is unchanged, persist non-scope fields only (no re-mint;
// position-keyed codes survive the tier-row recreation); else provision + eager-mint the NEW config's
// codes FULLY (row still on the old hash, so /validate keeps serving the old version), COMMIT the new
// config in one update (the atomic flip — /validate now serves the new version), then tear down the OLD
// version's codes. A mint failure before the commit leaves the live campaign fully intact. A live
// SCHEDULE edit is refused (ScheduleEditRequiresDeactivationError).
export async function supersedeCampaign(
  shopId: string,
  campaignId: string,
  input: CampaignInputDTO,
  deps: SupersedeDeps,
): Promise<CampaignResponse | null> {
  const existing = await deps.campaignRepo.findById(campaignId);
  if (existing === null || existing.shopId !== shopId) {
    return null;
  }
  assertCampaignInputValid(input);
  await assertVariantsLive(input, deps.variantGateway);
  const newHash = toConfigVersionHash(input);
  const newInput = toNewCampaignInput(input, newHash);

  // Inactive draft: plain persist (no live codes to supersede).
  if (!existing.active) {
    return campaignToResponse(await deps.campaignRepo.update(campaignId, newInput));
  }

  // Live campaign: schedule edits go through deactivate→re-activate, not supersede.
  if (windowChanged(input, existing)) {
    throw new ScheduleEditRequiresDeactivationError(campaignId);
  }

  // Scope unchanged (name/decline only): persist without re-minting — the position-keyed codes stay
  // valid even though the tier rows are recreated.
  if (newHash === existing.configVersionHash) {
    return campaignToResponse(await deps.campaignRepo.update(campaignId, newInput));
  }

  // Scope changed → gap-free supersede. Mint the new version FULLY before the commit.
  const newCampaign = withNewConfig(existing, input, newHash);
  await provisionGifts(deps.gateway, allGiftVariantIds(newCampaign), {
    giftsIncluded: deps.giftsIncluded,
  });
  // existing.qualifyingCollectionId is guaranteed non-null: the campaign is ACTIVE, and activation
  // refused null (MissingQualifyingCollectionError). The non-null assertion is safe.
  await eagerMint(newCampaign, existing.qualifyingCollectionId as string, existing.startsAt, deps);

  // COMMIT: flip the persisted config (configVersionHash N -> N+1). /validate now keys on N+1.
  const updated = await deps.campaignRepo.update(campaignId, newInput);

  // Post-commit: tear down ONLY the old-version codes (keep the just-minted N+1 codes).
  await deps.mappingStore.teardownCampaign(campaignId, { keepConfigVersionHash: newHash });
  return campaignToResponse(updated);
}
