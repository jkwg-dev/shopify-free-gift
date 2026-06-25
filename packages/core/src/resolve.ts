import { computeQualifyingSubtotal, type CartLine } from './cart.js';
import { resolveGiftSet, type Gift } from './gifts.js';
import type { Money } from './money.js';
import { isCampaignActive, type Schedule } from './schedule.js';
import {
  applySuppression,
  resolveQualifiedTiers,
  type SuppressionMode,
  type Tier,
} from './tiers.js';

// A campaign evaluated for a single resolved market: every threshold and price is already in
// `currency`. FX and market resolution happen upstream (CLAUDE.md FX decision).
export type Campaign = {
  readonly currency: string;
  readonly schedule: Schedule;
  readonly suppression: SuppressionMode;
  readonly tiers: readonly Tier[];
};

export type ResolveInput = {
  readonly campaign: Campaign;
  readonly cart: readonly CartLine[];
  readonly now: Date;
  // Per-tier OR selections, keyed by tier id. Ignored for AND tiers; required for any active
  // OR tier (a missing or unknown choice is rejected by resolveGiftSet).
  readonly choices: Readonly<Record<string, string>>;
  // The shopper unchecked "Add my free gift" — no gift is resolved, so no code is minted.
  readonly declined: boolean;
};

// One qualified tier's resolved gifts. Each entry is the unit-testable input to the minting
// key (tierId + resolved gift-set); the hashing and Shopify code creation live in
// packages/shopify, not here.
export type ResolvedTierGift = {
  readonly tierId: string;
  readonly gifts: readonly Gift[];
};

export type ResolveResult =
  | { readonly status: 'inactive' }
  | {
      readonly status: 'no-gift';
      readonly subtotal: Money;
      readonly reason: 'below-threshold' | 'declined';
    }
  | {
      readonly status: 'gifts';
      readonly subtotal: Money;
      readonly resolved: readonly ResolvedTierGift[];
    };

// Server-authoritative resolution for /validate: recompute subtotal and the qualifying
// tier(s) from scratch, never trusting client totals or tier claims.
export function resolveActiveGifts(input: ResolveInput): ResolveResult {
  const { campaign, cart, now, choices, declined } = input;

  if (!isCampaignActive(campaign.schedule, now)) {
    return { status: 'inactive' };
  }

  const subtotal = computeQualifyingSubtotal(cart, campaign.currency);

  if (declined) {
    return { status: 'no-gift', subtotal, reason: 'declined' };
  }

  const qualified = resolveQualifiedTiers(campaign.tiers, subtotal);
  const activeTiers = applySuppression(qualified, campaign.suppression);

  if (activeTiers.length === 0) {
    return { status: 'no-gift', subtotal, reason: 'below-threshold' };
  }

  const resolved = activeTiers.map((tier) => ({
    tierId: tier.id,
    gifts: resolveGiftSet(tier.gift, choices[tier.id]),
  }));

  return { status: 'gifts', subtotal, resolved };
}
