// Admin-layer campaign validation (Stage B). Delegates tier SHAPE to core's validateCampaignConfig
// and adds the admin POLICY/format checks that don't belong in core: suppression must be
// highest-only (cumulative is unbuildable on Advanced — CLAUDE.md), the schedule must be well-formed
// and ordered, and the name must be non-empty. Pure and unit-tested; the service calls it before any
// persist. Operates on the frozen CampaignInputDTO (after editor->DTO mapping).
import { validateCampaignConfig, type ConfigIssueCode } from '@free-gift-engine/core';
import type { CampaignInputDTO } from '../contract.js';

// Admin issue codes = the campaign-level checks here PLUS the tier-shape codes from core.
export type CampaignInputIssueCode =
  | 'empty-name'
  | 'suppression-unsupported'
  | 'invalid-schedule'
  | 'schedule-order'
  | 'duplicate-market'
  | ConfigIssueCode;

export type CampaignInputIssue = {
  readonly code: CampaignInputIssueCode;
  readonly message: string;
  readonly position?: number;
};

// All validation failures for one campaign write, surfaced together. The route maps it to a 400
// VALIDATION ApiError (message = joined issue messages).
export class CampaignConfigError extends Error {
  constructor(readonly issues: readonly CampaignInputIssue[]) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'CampaignConfigError';
  }
}

function isValidInstant(iso: string): boolean {
  return Number.isFinite(Date.parse(iso));
}

function hasDuplicateMarkets(input: CampaignInputDTO): boolean {
  return input.tiers.some((tier) => {
    const markets = tier.marketThresholds.map((m) => m.market);
    return new Set(markets).size !== markets.length;
  });
}

// Validate a campaign input. Returns every issue (empty = valid).
export function validateCampaignInput(input: CampaignInputDTO): CampaignInputIssue[] {
  const issues: CampaignInputIssue[] = [];

  if (input.name.trim().length === 0) {
    issues.push({ code: 'empty-name', message: 'Campaign name is required.' });
  }

  if (input.suppression !== 'highest-only') {
    issues.push({
      code: 'suppression-unsupported',
      message: 'Suppression must be "highest tier only"; cumulative is not supported on this plan.',
    });
  }

  if (!isValidInstant(input.startsAt) || !isValidInstant(input.endsAt)) {
    issues.push({ code: 'invalid-schedule', message: 'Start and end dates must be valid.' });
  } else if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) {
    issues.push({ code: 'schedule-order', message: 'Start date must be before end date.' });
  }

  if (hasDuplicateMarkets(input)) {
    issues.push({ code: 'duplicate-market', message: 'A market is listed twice in a tier.' });
  }

  issues.push(
    ...validateCampaignConfig(
      input.tiers.map((t) => ({ position: t.position, threshold: t.baseThreshold, gift: t.gift })),
    ),
  );

  return issues;
}

// Throwing wrapper used by the service write path.
export function assertCampaignInputValid(input: CampaignInputDTO): void {
  const issues = validateCampaignInput(input);
  if (issues.length > 0) {
    throw new CampaignConfigError(issues);
  }
}
