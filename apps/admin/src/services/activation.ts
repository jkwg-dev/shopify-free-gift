// Campaign activation/deactivation. Phase 3c Stage C2 makes ACTIVATE the side-effecting hub: it
// provisions the shared qualifying scope and EAGER-MINTS every per-tier BXGY code (bounded-parallel,
// window-bounded with endsAt) BEFORE flipping `active` — so the first storefront /validate just READS a
// stored code (never a synchronous mint on the checkout-click path), and a provisioning/mint failure
// leaves the campaign INACTIVE (never half-live) with a precise error. Mutual exclusion is still
// REJECT-if-another-active (the confirm-and-replace swap + code teardown are C3). Ownership is checked
// here. Pure over the ports + injected gateway/mapping store — unit-tested with fakes.
import { resolvedGiftSetHash, type Gift, type Money } from '@free-gift-engine/core';
import type { DiscountCombinesWith } from '@free-gift-engine/shopify';
import type { CampaignResponse } from '../contract.js';
import type { Campaign, MintingKey } from '../domain.js';
import type { CampaignRepository } from '../ports.js';
import type { GiftCodeMappingStore, GiftDiscountSpec } from '../store/giftCodeMapping.js';
import { GIFT_COMBINES_WITH } from '../validate/service.js';
import { campaignToResponse } from './campaign.js';
import { provisionGifts, type GiftTagGateway } from './giftLifecycle.js';

// Bounded concurrency for eager-minting: ~14 codes / 5 in flight ≈ 3 waves, well within the Vercel
// function budget while not hammering the Shopify discounts API. Tunable; measure the real activate
// round-trip on dev and raise/lower (or move to an async activation) if needed.
const MINT_CONCURRENCY = 5;

// Thrown when activating while a DIFFERENT FGE campaign is already active (≤ 1 active invariant). The
// route maps it to a 400; Stage C3 replaces this with confirm-and-replace.
export class AnotherCampaignActiveError extends Error {
  constructor(
    readonly activeId: string,
    readonly activeName: string,
  ) {
    super(`Another campaign ("${activeName}") is already active — deactivate it first.`);
    this.name = 'AnotherCampaignActiveError';
  }
}

export type MintFailure = {
  readonly tierId: string;
  readonly position: number;
  readonly variantIds: readonly string[];
  readonly message: string;
};

// Thrown when one or more per-tier codes fail to mint at activate. Carries the exact failing tiers +
// variants + Shopify message so the merchant sees WHICH gift is the problem (the campaign stays
// inactive). The route maps it to a 400.
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
  readonly combinesWith?: DiscountCombinesWith;
};

// One reusable code to mint: an AND tier is ONE set (all variants under one code); an OR tier is one
// set PER option (each option keys its own code). Mirrors what /validate mints lazily per winning set.
type MintTarget = {
  readonly tierId: string;
  readonly position: number;
  readonly gifts: readonly Gift[];
  readonly minimumSubtotal: Money;
};

function mintTargets(campaign: Campaign): MintTarget[] {
  return campaign.tiers.flatMap((tier) => {
    const base = { tierId: tier.id, position: tier.position, minimumSubtotal: tier.baseThreshold };
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

// Run `fn` over items with at most `limit` in flight; settle ALL (never short-circuit) so one failure
// doesn't abandon other in-flight mints (each is idempotent + reused on retry).
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

async function eagerMint(
  campaign: Campaign,
  collectionId: string,
  deps: ActivationDeps,
): Promise<void> {
  const targets = mintTargets(campaign);
  const startsAt = campaign.startsAt.toISOString();
  const endsAt = campaign.endsAt.toISOString();
  const combinesWith = deps.combinesWith ?? GIFT_COMBINES_WITH;

  const settled = await runBounded(targets, MINT_CONCURRENCY, (t) => {
    const key: MintingKey = {
      campaignId: campaign.id,
      tierId: t.tierId,
      resolvedGiftSetHash: resolvedGiftSetHash(t.gifts),
      configVersionHash: campaign.configVersionHash,
    };
    const spec: GiftDiscountSpec = {
      title: `${campaign.name} — tier ${t.position}`,
      giftVariantIds: t.gifts.map((g) => g.variantId),
      minimumSubtotal: t.minimumSubtotal,
      qualifyingCollectionId: collectionId,
      startsAt,
      endsAt,
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
    return [
      {
        tierId: t.tierId,
        position: t.position,
        variantIds: t.gifts.map((g) => g.variantId),
        message,
      },
    ];
  });
  if (failures.length > 0) {
    throw new ActivationMintError(failures);
  }
}

// Activate a campaign owned by `shopId`. null when not found / not owned (-> 404). Idempotent when
// already active. Throws AnotherCampaignActiveError (different campaign active), GiftProvisioningError
// (broken scope), or ActivationMintError (a code failed to mint) — in all of which the campaign stays
// INACTIVE. The `active` flip is the LAST step (commit point), AFTER provision + every code is minted.
export async function activateCampaign(
  shopId: string,
  campaignId: string,
  deps: ActivationDeps,
): Promise<CampaignResponse | null> {
  const campaign = await deps.campaignRepo.findById(campaignId);
  if (campaign === null || campaign.shopId !== shopId) {
    return null;
  }
  if (campaign.active) {
    return campaignToResponse(campaign); // already active — no-op (no re-provision/re-mint)
  }
  const other = await deps.campaignRepo.findActiveByShop(shopId);
  if (other !== null && other.id !== campaignId) {
    throw new AnotherCampaignActiveError(other.id, other.name);
  }

  const provision = await provisionGifts(deps.gateway, allGiftVariantIds(campaign), {
    giftsIncluded: deps.giftsIncluded,
  });
  await eagerMint(campaign, provision.collectionId, deps);

  await deps.campaignRepo.setActive(campaignId, true); // commit LAST
  return campaignToResponse({ ...campaign, active: true });
}

// Deactivate a campaign owned by `shopId`. null when not found / not owned. Idempotent when already
// inactive. Stage C2 flips the flag only (the lazy /validate gate stops offering immediately, and the
// minted codes carry endsAt so they expire with the schedule); explicit code teardown is C3.
export async function deactivateCampaign(
  shopId: string,
  campaignId: string,
  deps: Pick<ActivationDeps, 'campaignRepo'>,
): Promise<CampaignResponse | null> {
  const campaign = await deps.campaignRepo.findById(campaignId);
  if (campaign === null || campaign.shopId !== shopId) {
    return null;
  }
  if (!campaign.active) {
    return campaignToResponse(campaign); // already inactive — no-op
  }
  await deps.campaignRepo.setActive(campaignId, false);
  return campaignToResponse({ ...campaign, active: false });
}
