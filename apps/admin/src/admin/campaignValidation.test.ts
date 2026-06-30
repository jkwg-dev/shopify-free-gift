import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { CampaignInputDTO, TierDTO } from '../contract.js';
import {
  CampaignConfigError,
  assertCampaignInputValid,
  validateCampaignInput,
} from './campaignValidation.js';

function tier(overrides: Partial<TierDTO> = {}): TierDTO {
  return {
    position: 1,
    baseThreshold: money(5000, 'USD'),
    gift: { kind: 'OR', options: [{ id: 'a', variantId: 'v1' }] },
    marketThresholds: [],
    ...overrides,
  };
}

function input(overrides: Partial<CampaignInputDTO> = {}): CampaignInputDTO {
  return {
    name: 'Summer',
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-07-31T00:00:00.000Z',
    displayTimezone: 'UTC',
    qualifyingCollectionId: 'gid://shopify/Collection/q',
    tiers: [tier()],
    ...overrides,
  };
}

const codes = (i: CampaignInputDTO): string[] => validateCampaignInput(i).map((x) => x.code);

describe('validateCampaignInput', () => {
  it('accepts a valid highest-only draft', () => {
    expect(validateCampaignInput(input())).toEqual([]);
  });

  it('rejects cumulative suppression (unsupported on Advanced)', () => {
    expect(codes(input({ suppression: 'cumulative' }))).toContain('suppression-unsupported');
  });

  it('requires a non-empty name', () => {
    expect(codes(input({ name: '   ' }))).toContain('empty-name');
  });

  it('rejects an invalid schedule', () => {
    expect(codes(input({ startsAt: 'not-a-date' }))).toContain('invalid-schedule');
  });

  it('rejects start >= end', () => {
    expect(
      codes(input({ startsAt: '2026-07-31T00:00:00.000Z', endsAt: '2026-07-01T00:00:00.000Z' })),
    ).toContain('schedule-order');
  });

  it('rejects a market listed twice in a tier', () => {
    const dup = tier({
      marketThresholds: [
        {
          market: 'US',
          presentmentCurrency: 'USD',
          manualFxRate: null,
          roundingRule: 'none',
          resolvedThreshold: money(5000, 'USD'),
        },
        {
          market: 'US',
          presentmentCurrency: 'USD',
          manualFxRate: null,
          roundingRule: 'none',
          resolvedThreshold: money(6000, 'USD'),
        },
      ],
    });
    expect(codes(input({ tiers: [dup] }))).toContain('duplicate-market');
  });

  it('requires a qualifying collection', () => {
    expect(codes(input({ qualifyingCollectionId: null }))).toContain(
      'missing-qualifying-collection',
    );
    expect(codes(input())).not.toContain('missing-qualifying-collection');
  });

  it('delegates tier-shape checks to core (AND needs 2 gifts)', () => {
    const single = tier({ gift: { kind: 'AND', gifts: [{ variantId: 'v1' }] } });
    expect(codes(input({ tiers: [single] }))).toContain('and-needs-2-gifts');
  });
});

describe('assertCampaignInputValid', () => {
  it('does not throw on a valid input', () => {
    expect(() => assertCampaignInputValid(input())).not.toThrow();
  });

  it('throws CampaignConfigError carrying the issues', () => {
    try {
      assertCampaignInputValid(input({ suppression: 'cumulative', name: '' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignConfigError);
      expect((err as CampaignConfigError).issues.map((i) => i.code)).toEqual(
        expect.arrayContaining(['suppression-unsupported', 'empty-name']),
      );
    }
  });
});
