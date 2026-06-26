// Pure view-model for the embedded admin's read-only campaign list (Phase 3b Stage A). Maps the
// persisted Campaign[] to display rows + a derived status, using core's isCampaignActive for the
// "live now?" window check (the SAME check /validate uses). No I/O, no formatting (the React layer
// formats Money), so it is unit-tested without a DOM.
import { isCampaignActive, type Money, type SuppressionMode } from '@free-gift-engine/core';
import type { Campaign } from '../domain.js';

// 'live' = manually active AND within [startsAt, endsAt]; 'scheduled' = active but before startsAt;
// 'ended' = active but past endsAt; 'inactive' = not manually activated.
export type CampaignStatus = 'live' | 'scheduled' | 'ended' | 'inactive';

export type TierSummary = {
  readonly position: number;
  readonly threshold: Money; // base-currency threshold; the React layer formats it
  readonly kind: 'OR' | 'AND';
  readonly giftCount: number; // OR: number of options; AND: number of bundled gifts
};

export type CampaignListRow = {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly liveNow: boolean; // status === 'live'
  readonly startsAt: string; // ISO 8601 (UTC instant)
  readonly endsAt: string;
  readonly displayTimezone: string;
  readonly suppression: SuppressionMode;
  readonly tiers: readonly TierSummary[];
};

function statusOf(campaign: Campaign, now: Date): CampaignStatus {
  if (!campaign.active) {
    return 'inactive';
  }
  if (isCampaignActive({ startsAt: campaign.startsAt, endsAt: campaign.endsAt }, now)) {
    return 'live';
  }
  return now < campaign.startsAt ? 'scheduled' : 'ended';
}

function tierSummary(tier: Campaign['tiers'][number]): TierSummary {
  const giftCount = tier.gift.kind === 'AND' ? tier.gift.gifts.length : tier.gift.options.length;
  return {
    position: tier.position,
    threshold: tier.baseThreshold,
    kind: tier.gift.kind,
    giftCount,
  };
}

export function campaignListRows(campaigns: readonly Campaign[], now: Date): CampaignListRow[] {
  return campaigns.map((c) => {
    const status = statusOf(c, now);
    return {
      id: c.id,
      name: c.name,
      status,
      liveNow: status === 'live',
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      displayTimezone: c.displayTimezone,
      suppression: c.suppression,
      tiers: [...c.tiers].sort((a, b) => a.position - b.position).map(tierSummary),
    };
  });
}
