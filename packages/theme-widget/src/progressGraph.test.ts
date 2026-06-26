import { money, type CampaignConfigResponse, type ValidateResult } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { buildProgressModel, giftLabelFor } from './progressGraph.js';

const ICE = 'gid://shopify/ProductVariant/Ice';
const DAWN = 'gid://shopify/ProductVariant/Dawn';
const HIDDEN = 'gid://shopify/ProductVariant/Hidden';
const MULTI = 'gid://shopify/ProductVariant/Multi';

const config: CampaignConfigResponse = {
  status: 'active',
  currency: 'CAD',
  declineEnabled: true,
  tiers: [
    {
      tierId: 't1',
      position: 1,
      threshold: money(50000, 'CAD'),
      gift: {
        kind: 'OR',
        options: [
          { optionId: 'a', variantId: ICE, productId: 'p/c', variantLabel: 'Ice', available: true },
          {
            optionId: 'b',
            variantId: DAWN,
            productId: 'p/c',
            variantLabel: 'Dawn',
            available: true,
          },
        ],
      },
    },
    {
      tierId: 't2',
      position: 2,
      threshold: money(100000, 'CAD'),
      gift: {
        kind: 'AND',
        gifts: [
          {
            variantId: HIDDEN,
            productId: 'p/h',
            variantLabel: 'The Hidden Snowboard',
            available: true,
          },
          {
            variantId: MULTI,
            productId: 'p/m',
            variantLabel: 'The Multi-location Snowboard',
            available: true,
          },
        ],
      },
    },
    {
      tierId: 't3',
      position: 3,
      threshold: money(150000, 'CAD'),
      gift: {
        kind: 'OR',
        options: Array.from({ length: 8 }, (_, i) => ({
          optionId: `opt-${i + 1}`,
          variantId: `gid://shopify/ProductVariant/h${i}`,
          productId: `p/h${i}`,
          variantLabel: `Hat ${i + 1}`,
          available: true,
        })),
      },
    },
  ],
};

function gift(tierId: string, subtotalMinor: number): ValidateResult {
  return {
    status: 'gift',
    currency: 'CAD',
    subtotal: money(subtotalMinor, 'CAD'),
    tierId,
    giftVariantIds: [ICE],
    code: 'CODE',
    appliedThreshold: money(50000, 'CAD'),
  };
}

describe('giftLabelFor', () => {
  it('joins AND variants, lists few OR options, and summarizes many', () => {
    expect(giftLabelFor(config.status === 'active' ? config.tiers[0]!.gift : ({} as never))).toBe(
      'Ice / Dawn',
    );
    expect(giftLabelFor(config.status === 'active' ? config.tiers[1]!.gift : ({} as never))).toBe(
      'The Hidden Snowboard + The Multi-location Snowboard',
    );
    expect(giftLabelFor(config.status === 'active' ? config.tiers[2]!.gift : ({} as never))).toBe(
      'Choose 1 of 8',
    );
  });
});

describe('buildProgressModel', () => {
  it('returns null for an inactive campaign', () => {
    expect(buildProgressModel({ status: 'inactive' }, null)).toBeNull();
  });

  it('at tier 1 (subtotal CA$600): tier1 reached+current, next=tier2 with spendMore CA$400', () => {
    const m = buildProgressModel(config, gift('t1', 60000))!;
    expect(m.subtotal).toEqual(money(60000, 'CAD'));
    expect(m.tiers.map((t) => [t.tierId, t.reached, t.isCurrent])).toEqual([
      ['t1', true, true],
      ['t2', false, false],
      ['t3', false, false],
    ]);
    expect(m.next).toEqual({
      tierId: 't2',
      threshold: money(100000, 'CAD'),
      giftLabel: 'The Hidden Snowboard + The Multi-location Snowboard',
      spendMore: money(40000, 'CAD'),
    });
    expect(m.allUnlocked).toBe(false);
  });

  it('at the top tier (subtotal CA$1800): all reached, no next, allUnlocked', () => {
    const m = buildProgressModel(config, gift('t3', 180000))!;
    expect(m.tiers.every((t) => t.reached)).toBe(true);
    expect(m.next).toBeNull();
    expect(m.allUnlocked).toBe(true);
  });

  it('no-gift / below threshold: subtotal unknown, nothing reached, next=tier1 with spendMore null', () => {
    const m = buildProgressModel(config, { status: 'no-gift', reason: 'below-threshold' })!;
    expect(m.subtotal).toBeNull();
    expect(m.tiers.some((t) => t.reached)).toBe(false);
    expect(m.next?.tierId).toBe('t1');
    expect(m.next?.spendMore).toBeNull(); // never guesses a delta without a server subtotal
    expect(m.next?.threshold).toEqual(money(50000, 'CAD'));
  });

  it('null lastResult (initial load): ladder shown, next=tier1, no reached', () => {
    const m = buildProgressModel(config, null)!;
    expect(m.subtotal).toBeNull();
    expect(m.next?.tierId).toBe('t1');
    expect(m.allUnlocked).toBe(false);
  });
});
