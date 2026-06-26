import { describe, expect, it } from 'vitest';
import { validateCampaignConfig, type TierConfigForValidation } from './configValidation.js';
import { money } from './money.js';
import type { GiftConfig } from './gifts.js';

const and = (...variantIds: string[]): GiftConfig => ({
  kind: 'AND',
  gifts: variantIds.map((variantId) => ({ variantId })),
});
const or = (...variantIds: string[]): GiftConfig => ({
  kind: 'OR',
  options: variantIds.map((variantId, i) => ({ id: `opt-${i + 1}`, variantId })),
});

const tier = (
  position: number,
  amount: number,
  gift: GiftConfig,
  currency = 'USD',
): TierConfigForValidation => ({ position, threshold: money(amount, currency), gift });

const codes = (tiers: readonly TierConfigForValidation[]): string[] =>
  validateCampaignConfig(tiers).map((i) => i.code);

describe('validateCampaignConfig', () => {
  it('accepts a well-formed ascending tier set (OR + AND)', () => {
    const tiers = [tier(1, 5000, or('gid://v/1')), tier(2, 10000, and('gid://v/2', 'gid://v/3'))];
    expect(validateCampaignConfig(tiers)).toEqual([]);
  });

  it('rejects an empty tier set', () => {
    expect(codes([])).toEqual(['no-tiers']);
  });

  it('flags duplicate tier positions', () => {
    const tiers = [tier(1, 5000, or('a')), tier(1, 10000, or('b'))];
    expect(codes(tiers)).toContain('duplicate-position');
  });

  it('requires base thresholds to strictly ascend with position', () => {
    expect(codes([tier(1, 10000, or('a')), tier(2, 5000, or('b'))])).toContain(
      'thresholds-not-ascending',
    );
    // equal thresholds are not strictly ascending
    expect(codes([tier(1, 5000, or('a')), tier(2, 5000, or('b'))])).toContain(
      'thresholds-not-ascending',
    );
  });

  it('checks ascending by position, not array order', () => {
    // Listed out of order but ascending once sorted by position → valid.
    const tiers = [tier(2, 10000, or('b')), tier(1, 5000, or('a'))];
    expect(validateCampaignConfig(tiers)).toEqual([]);
  });

  it('flags a base-threshold currency mismatch and skips the ascending check', () => {
    const tiers = [tier(1, 5000, or('a'), 'USD'), tier(2, 10000, or('b'), 'EUR')];
    const result = codes(tiers);
    expect(result).toContain('thresholds-currency-mismatch');
    expect(result).not.toContain('thresholds-not-ascending');
  });

  it('requires an AND tier to have at least 2 gifts', () => {
    expect(codes([tier(1, 5000, and('only'))])).toContain('and-needs-2-gifts');
  });

  it('requires an OR tier to have at least 1 option', () => {
    expect(codes([tier(1, 5000, { kind: 'OR', options: [] })])).toContain('or-needs-1-option');
  });

  it('forbids the same variant twice within a tier (AND and OR)', () => {
    expect(codes([tier(1, 5000, and('dup', 'dup'))])).toContain('duplicate-variant');
    expect(codes([tier(1, 5000, or('dup', 'dup'))])).toContain('duplicate-variant');
  });

  it('forbids empty variant ids', () => {
    expect(codes([tier(1, 5000, and('ok', '  '))])).toContain('empty-variant');
  });

  it('forbids duplicate or empty OR option ids', () => {
    const dupIds: GiftConfig = {
      kind: 'OR',
      options: [
        { id: 'x', variantId: 'v1' },
        { id: 'x', variantId: 'v2' },
      ],
    };
    expect(codes([tier(1, 5000, dupIds)])).toContain('duplicate-option-id');
    const emptyId: GiftConfig = { kind: 'OR', options: [{ id: '', variantId: 'v1' }] };
    expect(codes([tier(1, 5000, emptyId)])).toContain('empty-option-id');
  });

  it('reports multiple issues at once', () => {
    const tiers = [tier(1, 10000, and('only')), tier(2, 5000, or('dup', 'dup'))];
    const result = codes(tiers);
    expect(result).toContain('and-needs-2-gifts');
    expect(result).toContain('thresholds-not-ascending');
    expect(result).toContain('duplicate-variant');
  });
});
