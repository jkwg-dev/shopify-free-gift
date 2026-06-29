import { computeQualifyingSubtotal, type CartLine } from './cart.js';
import { resolveGiftSet, type AndChoices, type Gift } from './gifts.js';
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
  // Per-tier selections. OR tiers: keyed by tier id → option id. AND tiers: compound keys
  // `tierId:productId` → chosen variant id (1 per product). Missing AND choices → all gifts.
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

// Extract AND-tier per-product choices for a given tier from the flat choices map. Compound keys
// follow the format `tierId:productId → variantId`. Returns an empty object when no AND choices
// exist (backward compat: resolveGiftSet falls back to returning all gifts).
function extractAndChoices(tierId: string, choices: Readonly<Record<string, string>>): AndChoices {
  const prefix = `${tierId}:`;
  const result: Record<string, string> = {};
  for (const key of Object.keys(choices)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = choices[key]!;
    }
  }
  return result;
}

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
    gifts: resolveGiftSet(tier.gift, choices[tier.id], extractAndChoices(tier.id, choices)),
  }));

  return { status: 'gifts', subtotal, resolved };
}
