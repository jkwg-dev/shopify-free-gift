// Campaign activation/deactivation (Phase 3c, Stage C1: flip-only). This is the FIRST supported path
// to set `active` — create/update never touch it. Stage C1 enforces mutual exclusion by REJECTING an
// activation when another FGE campaign is already active (the confirm-and-replace swap is C3); it does
// NOT yet eager-provision or eager-mint (codes are still minted lazily at /validate today). Ownership
// is checked here (campaign.shopId === the JWT-verified shopId) so a campaign of another shop is a 404.
// Pure over the CampaignRepository port — unit-tested with the in-memory fake.
import type { CampaignResponse } from '../contract.js';
import type { CampaignRepository } from '../ports.js';
import { campaignToResponse } from './campaign.js';

// Thrown when activating while a DIFFERENT FGE campaign is already active (≤ 1 active invariant). The
// route maps it to a 400 VALIDATION; Stage C3 replaces this with confirm-and-replace.
export class AnotherCampaignActiveError extends Error {
  constructor(
    readonly activeId: string,
    readonly activeName: string,
  ) {
    super(`Another campaign ("${activeName}") is already active — deactivate it first.`);
    this.name = 'AnotherCampaignActiveError';
  }
}

export type ActivationDeps = { readonly campaignRepo: CampaignRepository };

// Activate a campaign owned by `shopId`. Returns null when not found / not owned (-> 404). Idempotent
// when the campaign is already active. Throws AnotherCampaignActiveError when a different campaign is
// active. Codes remain lazily minted at /validate (Stage C1).
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
    return campaignToResponse(campaign); // already active — no-op
  }
  const active = await deps.campaignRepo.findActiveByShop(shopId);
  if (active !== null && active.id !== campaignId) {
    throw new AnotherCampaignActiveError(active.id, active.name);
  }
  await deps.campaignRepo.setActive(campaignId, true);
  return campaignToResponse({ ...campaign, active: true });
}

// Deactivate a campaign owned by `shopId`. Returns null when not found / not owned. Idempotent when
// already inactive. (Stage C1 only flips the flag; code teardown is C2/C3.)
export async function deactivateCampaign(
  shopId: string,
  campaignId: string,
  deps: ActivationDeps,
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
