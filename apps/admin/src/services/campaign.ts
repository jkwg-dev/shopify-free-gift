import { configVersionHash, type GiftConfig } from '@free-gift-engine/core';
import type {
  CampaignInputDTO,
  CampaignResponse,
  ListCampaignsResponse,
  ValidateVariantsResponse,
} from '../contract.js';
import { assertCampaignInputValid } from '../admin/campaignValidation.js';
import type { Campaign } from '../domain.js';
import type { CampaignRepository, GiftVariantGateway, NewCampaignInput } from '../ports.js';
import { supersedeStaleDiscounts, type SupersedeDeps } from './supersede.js';

// Thrown when a campaign references variants that are not live; the route layer maps it to a
// VALIDATION ApiError listing the offending ids.
export class CampaignValidationError extends Error {
  constructor(readonly invalidVariantIds: readonly string[]) {
    super(`Invalid gift variants: ${invalidVariantIds.join(', ')}`);
    this.name = 'CampaignValidationError';
  }
}

export type CampaignServiceDeps = {
  readonly campaignRepo: CampaignRepository;
  readonly variantGateway: GiftVariantGateway;
} & SupersedeDeps;

function giftVariantIds(gift: GiftConfig): string[] {
  return gift.kind === 'AND'
    ? gift.gifts.map((g) => g.variantId)
    : gift.options.map((o) => o.variantId);
}

function allVariantIds(input: CampaignInputDTO): string[] {
  return [...new Set(input.tiers.flatMap((tier) => giftVariantIds(tier.gift)))];
}

function toConfigVersionHash(input: CampaignInputDTO): string {
  return configVersionHash({
    suppression: input.suppression,
    tiers: input.tiers.map((tier) => ({ threshold: tier.baseThreshold, gift: tier.gift })),
  });
}

function toNewCampaignInput(input: CampaignInputDTO, hash: string): NewCampaignInput {
  return {
    name: input.name,
    suppression: input.suppression,
    declineEnabled: input.declineEnabled,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    displayTimezone: input.displayTimezone,
    configVersionHash: hash,
    tiers: input.tiers.map((tier) => ({
      position: tier.position,
      baseThreshold: tier.baseThreshold,
      gift: tier.gift,
      marketThresholds: tier.marketThresholds,
    })),
  };
}

function toResponse(campaign: Campaign): CampaignResponse {
  return {
    id: campaign.id,
    shopId: campaign.shopId,
    name: campaign.name,
    suppression: campaign.suppression,
    declineEnabled: campaign.declineEnabled,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    displayTimezone: campaign.displayTimezone,
    active: campaign.active,
    configVersionHash: campaign.configVersionHash,
    tiers: campaign.tiers.map((tier) => ({
      id: tier.id,
      position: tier.position,
      baseThreshold: tier.baseThreshold,
      gift: tier.gift,
      marketThresholds: tier.marketThresholds.map((m) => ({
        market: m.market,
        presentmentCurrency: m.presentmentCurrency,
        manualFxRate: m.manualFxRate,
        roundingRule: m.roundingRule,
        resolvedThreshold: m.resolvedThreshold,
      })),
    })),
  };
}

// Validate every referenced gift variant is live; throws CampaignValidationError otherwise.
async function assertVariantsLive(
  input: CampaignInputDTO,
  variantGateway: GiftVariantGateway,
): Promise<void> {
  const ids = allVariantIds(input);
  if (ids.length === 0) {
    return;
  }
  try {
    await variantGateway.fetch(ids);
  } catch {
    // The gateway adapter throws on any dead variant; we surface the offending ids.
    throw new CampaignValidationError(ids);
  }
}

export async function createCampaign(
  shopId: string,
  input: CampaignInputDTO,
  deps: CampaignServiceDeps,
): Promise<CampaignResponse> {
  // Cheap pure checks (shape, suppression, schedule) before the I/O variant-liveness check.
  assertCampaignInputValid(input);
  await assertVariantsLive(input, deps.variantGateway);
  const hash = toConfigVersionHash(input);
  // active defaults to false in the repo — Stage B only creates inactive drafts (activation is 3C).
  const campaign = await deps.campaignRepo.create(shopId, toNewCampaignInput(input, hash));
  return toResponse(campaign);
}

export async function updateCampaign(
  campaignId: string,
  input: CampaignInputDTO,
  deps: CampaignServiceDeps,
): Promise<CampaignResponse> {
  assertCampaignInputValid(input);
  await assertVariantsLive(input, deps.variantGateway);
  const hash = toConfigVersionHash(input);
  const campaign = await deps.campaignRepo.update(campaignId, toNewCampaignInput(input, hash));
  // Deactivate any codes minted under the previous config (no-op if the scope didn't change).
  await supersedeStaleDiscounts(campaignId, hash, deps);
  return toResponse(campaign);
}

export async function getCampaign(
  campaignId: string,
  deps: Pick<CampaignServiceDeps, 'campaignRepo'>,
): Promise<CampaignResponse | null> {
  const campaign = await deps.campaignRepo.findById(campaignId);
  return campaign === null ? null : toResponse(campaign);
}

export async function listCampaigns(
  shopId: string,
  deps: Pick<CampaignServiceDeps, 'campaignRepo'>,
): Promise<ListCampaignsResponse> {
  const campaigns = await deps.campaignRepo.listByShop(shopId);
  return { campaigns: campaigns.map(toResponse) };
}

export async function validateVariants(
  variantIds: readonly string[],
  deps: Pick<CampaignServiceDeps, 'variantGateway'>,
): Promise<ValidateVariantsResponse> {
  const variants = await deps.variantGateway.fetch(variantIds);
  return {
    variants: variants.map((v) => ({
      id: v.id,
      title: v.title,
      availableForSale: v.availableForSale,
    })),
  };
}
