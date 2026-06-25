import type { GiftConfig } from './gifts.js';
import { compareMoney, isAtLeast, type Money } from './money.js';

export type Tier = {
  readonly id: string;
  // Threshold already resolved to the evaluation currency (see CLAUDE.md FX decision).
  readonly threshold: Money;
  readonly gift: GiftConfig;
};

// Suppression mode is per-campaign config:
// - 'highest-only': only the top qualified tier's gift is free; lower gifts stay paid
//   (enforced downstream by discount scoping — no revenue leak).
// - 'cumulative': every qualified tier's gift is free.
export type SuppressionMode = 'highest-only' | 'cumulative';

// All tiers the subtotal qualifies for, sorted ascending by threshold.
// Qualification is inclusive: a subtotal exactly at the threshold qualifies; one minor unit
// below does not.
export function resolveQualifiedTiers(tiers: readonly Tier[], subtotal: Money): readonly Tier[] {
  return tiers
    .filter((tier) => isAtLeast(subtotal, tier.threshold))
    .slice()
    .sort((a, b) => compareMoney(a.threshold, b.threshold));
}

// Apply suppression to the qualified tiers. 'highest-only' returns just the highest-threshold
// qualified tier (found by value, not by relying on input order); 'cumulative' returns all.
export function applySuppression(
  qualified: readonly Tier[],
  mode: SuppressionMode,
): readonly Tier[] {
  if (mode === 'cumulative' || qualified.length === 0) {
    return qualified;
  }
  const highest = qualified.reduce((max, tier) =>
    compareMoney(tier.threshold, max.threshold) > 0 ? tier : max,
  );
  return [highest];
}
