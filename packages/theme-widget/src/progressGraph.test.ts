import { money, type CampaignConfigResponse, type ValidateResult } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { buildProgressModel, giftLabelFor, stepperLayout } from './progressGraph.js';

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

  it('null lastResult (initial load): ladder shown, next=tier1, no reached, PENDING', () => {
    const m = buildProgressModel(config, null)!;
    expect(m.subtotal).toBeNull();
    expect(m.next?.tierId).toBe('t1');
    expect(m.allUnlocked).toBe(false);
    expect(m.pending).toBe(true); // no server result yet → neutral headline, not a wrong lower tier
  });

  it('pending is false once a result is confirmed (gift OR below-threshold)', () => {
    expect(buildProgressModel(config, gift('t1', 60000))!.pending).toBe(false);
    expect(
      buildProgressModel(config, { status: 'no-gift', reason: 'below-threshold' })!.pending,
    ).toBe(false);
  });
});

describe('stepperLayout (visual geometry, pure)', () => {
  it('positions nodes by threshold/top, fills from the confirmed subtotal, end-aligns the last label', () => {
    const m = buildProgressModel(config, gift('t1', 60000))!; // subtotal CA$600, top CA$1500
    const { fillPct, nodes } = stepperLayout(m);
    expect(Math.round(fillPct)).toBe(40); // 600/1500
    expect(nodes.map((n) => Math.round(n.posPct))).toEqual([33, 67, 100]);
    // first/middle centered, the 100% node end-aligned so its label can't clip off the right edge
    expect(nodes.map((n) => n.align)).toEqual(['center', 'center', 'end']);
    expect(nodes.map((n) => n.reached)).toEqual([true, false, false]);
  });

  it('fill is 0 when the server has not confirmed a subtotal (no-gift)', () => {
    const m = buildProgressModel(config, { status: 'no-gift', reason: 'below-threshold' })!;
    expect(stepperLayout(m).fillPct).toBe(0);
  });

  it('fill caps at 100 at/above the top tier', () => {
    const m = buildProgressModel(config, gift('t3', 200000))!;
    expect(stepperLayout(m).fillPct).toBe(100);
  });
});
