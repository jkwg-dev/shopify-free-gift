import { describe, expect, it } from 'vitest';
import type { GiftConfig } from './gifts.js';
import { money } from './money.js';
import { applySuppression, resolveQualifiedTiers, type Tier } from './tiers.js';

const giftFor = (variantId: string): GiftConfig => ({ kind: 'AND', gifts: [{ variantId }] });

const silver: Tier = { id: 'silver', threshold: money(5000, 'USD'), gift: giftFor('s') };
const gold: Tier = { id: 'gold', threshold: money(10000, 'USD'), gift: giftFor('g') };
const tiers = [gold, silver]; // intentionally unsorted to prove ordering is by value

const ids = (ts: readonly Tier[]): string[] => ts.map((t) => t.id);

describe('resolveQualifiedTiers — boundaries', () => {
  it('qualifies a subtotal exactly at the threshold', () => {
    expect(ids(resolveQualifiedTiers(tiers, money(5000, 'USD')))).toEqual(['silver']);
  });

  it('does NOT qualify one minor unit below the threshold', () => {
    expect(ids(resolveQualifiedTiers(tiers, money(4999, 'USD')))).toEqual([]);
  });

  it('qualifies only the lower tier for a subtotal between two thresholds', () => {
    expect(ids(resolveQualifiedTiers(tiers, money(7500, 'USD')))).toEqual(['silver']);
  });

  it('qualifies both tiers and sorts ascending by threshold', () => {
    expect(ids(resolveQualifiedTiers(tiers, money(10000, 'USD')))).toEqual(['silver', 'gold']);
  });
});

describe('applySuppression', () => {
  const qualified = resolveQualifiedTiers(tiers, money(10000, 'USD')); // [silver, gold]

  it('highest-only returns just the top qualified tier', () => {
    expect(ids(applySuppression(qualified, 'highest-only'))).toEqual(['gold']);
  });

  it('cumulative returns all qualified tiers', () => {
    expect(ids(applySuppression(qualified, 'cumulative'))).toEqual(['silver', 'gold']);
  });

  it('finds the highest by value even if the input is not sorted', () => {
    expect(ids(applySuppression([silver, gold], 'highest-only'))).toEqual(['gold']);
    expect(ids(applySuppression([gold, silver], 'highest-only'))).toEqual(['gold']);
  });

  it('returns empty for no qualified tiers regardless of mode', () => {
    expect(applySuppression([], 'highest-only')).toEqual([]);
    expect(applySuppression([], 'cumulative')).toEqual([]);
  });
});
