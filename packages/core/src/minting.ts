import type { Gift, GiftConfig } from './gifts.js';
import { sha256Hex } from './hash.js';
import type { Money } from './money.js';
import type { SuppressionMode } from './tiers.js';

// The two hashes that key a reusable discount code (CLAUDE.md "discount code minting"). Both
// are pure functions of the campaign config / resolved gift-set, so the admin and /validate
// derive the same key from the same inputs and never re-implement the hashing themselves.

// The scope-determining config a discount code depends on: suppression mode, and per tier the
// base-currency threshold and gift-set. Deliberately identity-independent — no DB/tier id, so a
// brand-new campaign (ids not yet assigned) and an edit that recreates rows hash the same when the
// scope is unchanged. NOT included: schedule and decline (they change neither the discount's scope
// nor its minimum), and per-market FX (the minimum is always base currency).
export type ConfigVersionTier = {
  readonly threshold: Money;
  readonly gift: GiftConfig;
};

export type ConfigVersionInput = {
  readonly suppression: SuppressionMode;
  readonly tiers: readonly ConfigVersionTier[];
};

function canonicalGift(config: GiftConfig): string {
  if (config.kind === 'AND') {
    const ids = [...config.gifts.map((g) => g.variantId)].sort();
    return `AND[${ids.join(',')}]`;
  }
  const options = [...config.options.map((o) => `${o.id}=${o.variantId}`)].sort();
  return `OR[${options.join(',')}]`;
}

// Hash over the resolved gift-set (order-independent), so each distinct OR choice keys its own
// code and re-ordering the same variants never produces a different code.
export function resolvedGiftSetHash(gifts: readonly Gift[]): string {
  const ids = [...gifts.map((g) => g.variantId)].sort();
  return sha256Hex(`giftset/v1:[${ids.join(',')}]`);
}

// Hash over the scope-determining campaign config (tiers order-independent). A change here means
// a new code must be minted and the stale ones deactivated; an unrelated edit (schedule, FX,
// decline) leaves it unchanged so live codes are not needlessly churned.
export function configVersionHash(input: ConfigVersionInput): string {
  const tiers = [
    ...input.tiers.map(
      (t) => `${t.threshold.amountMinor}:${t.threshold.currency}|${canonicalGift(t.gift)}`,
    ),
  ].sort();
  return sha256Hex(`config/v1|suppression=${input.suppression}|tiers=[${tiers.join(';')}]`);
}
