// Pure structural validation of a campaign's tiers — the rules that make a tier set coherent before
// it can be persisted or activated. No I/O: it validates SHAPE (thresholds ascending, gift kinds,
// no duplicate variants), not liveness (that a variant still exists is an I/O check in the admin
// layer). Lives in core because "what makes a tier set valid" is a business rule shared by anything
// that writes campaigns. Suppression-mode policy and schedule order are NOT here: cumulative is a
// valid core mode (retained for future Plus), so rejecting it is an admin policy, not a core rule.
import { type GiftConfig } from './gifts.js';
import { compareMoney, type Money } from './money.js';

// The minimal tier shape this validator needs (a subset of the persisted/contract Tier).
export type TierConfigForValidation = {
  readonly position: number;
  readonly threshold: Money; // base-currency threshold; per-market figures don't affect ordering here
  readonly gift: GiftConfig;
};

export type ConfigIssueCode =
  | 'no-tiers'
  | 'duplicate-position'
  | 'thresholds-currency-mismatch'
  | 'thresholds-not-ascending'
  | 'and-needs-2-gifts'
  | 'or-needs-1-option'
  | 'empty-variant'
  | 'duplicate-variant'
  | 'duplicate-option-id'
  | 'empty-option-id';

// A single validation failure. `position` is set for tier-scoped issues so the UI can point at the
// offending tier; campaign-wide issues (no tiers, currency mismatch) omit it.
export type ConfigIssue = {
  readonly code: ConfigIssueCode;
  readonly message: string;
  readonly position?: number;
};

function variantIdsOf(gift: GiftConfig): readonly string[] {
  return gift.kind === 'AND'
    ? gift.gifts.map((g) => g.variantId)
    : gift.options.map((o) => o.variantId);
}

// Per-tier gift checks: cardinality (AND >= 2, OR >= 1), non-empty ids, and no variant or option-id
// reused within the tier (a variant listed twice, or two OR branches sharing a choice token).
function validateTierGift(tier: TierConfigForValidation, issues: ConfigIssue[]): void {
  const { position, gift } = tier;
  if (gift.kind === 'AND' && gift.gifts.length < 2) {
    issues.push({
      code: 'and-needs-2-gifts',
      position,
      message: `Tier ${position}: an AND gift needs at least 2 gifts.`,
    });
  }
  if (gift.kind === 'OR' && gift.options.length < 1) {
    issues.push({
      code: 'or-needs-1-option',
      position,
      message: `Tier ${position}: an OR gift needs at least 1 option.`,
    });
  }

  const variantIds = variantIdsOf(gift);
  if (variantIds.some((id) => id.trim().length === 0)) {
    issues.push({
      code: 'empty-variant',
      position,
      message: `Tier ${position}: every gift must reference a variant.`,
    });
  }
  const seenVariants = new Set<string>();
  for (const id of variantIds) {
    if (id.trim().length > 0 && seenVariants.has(id)) {
      issues.push({
        code: 'duplicate-variant',
        position,
        message: `Tier ${position}: the same variant is used more than once.`,
      });
      break;
    }
    seenVariants.add(id);
  }

  if (gift.kind === 'OR') {
    const ids = gift.options.map((o) => o.id);
    if (ids.some((id) => id.trim().length === 0)) {
      issues.push({
        code: 'empty-option-id',
        position,
        message: `Tier ${position}: every OR option needs a non-empty id.`,
      });
    }
    if (new Set(ids).size !== ids.length) {
      issues.push({
        code: 'duplicate-option-id',
        position,
        message: `Tier ${position}: OR option ids must be unique.`,
      });
    }
  }
}

// Validate a campaign's tier set. Returns every issue found (empty = valid) so the caller can show
// them all at once rather than one-at-a-time. Pure and total: never throws.
export function validateCampaignConfig(tiers: readonly TierConfigForValidation[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (tiers.length === 0) {
    issues.push({ code: 'no-tiers', message: 'A campaign needs at least one tier.' });
    return issues;
  }

  const positions = tiers.map((t) => t.position);
  if (new Set(positions).size !== positions.length) {
    issues.push({ code: 'duplicate-position', message: 'Tier positions must be unique.' });
  }

  for (const tier of tiers) {
    validateTierGift(tier, issues);
  }

  // Thresholds must strictly ascend with position so suppression always has a single highest tier.
  // Comparing requires one currency; flag a mismatch instead of throwing on compareMoney.
  const currencies = new Set(tiers.map((t) => t.threshold.currency));
  if (currencies.size > 1) {
    issues.push({
      code: 'thresholds-currency-mismatch',
      message: 'All tier base thresholds must use the same currency.',
    });
  } else {
    const sorted = [...tiers].sort((a, b) => a.position - b.position);
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      const previous = sorted[i - 1];
      if (
        current !== undefined &&
        previous !== undefined &&
        compareMoney(current.threshold, previous.threshold) <= 0
      ) {
        issues.push({
          code: 'thresholds-not-ascending',
          position: current.position,
          message: `Tier ${current.position}: threshold must be greater than the tier below it.`,
        });
      }
    }
  }

  return issues;
}
