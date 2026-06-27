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

  it('no-gift WITHOUT a subtotal (inactive): subtotal unknown, nothing reached, next=tier1', () => {
    const m = buildProgressModel(config, { status: 'no-gift', reason: 'inactive' })!;
    expect(m.subtotal).toBeNull();
    expect(m.tiers.some((t) => t.reached)).toBe(false);
    expect(m.next?.tierId).toBe('t1');
    expect(m.next?.spendMore).toBeNull();
  });

  it('no-gift WITH a subtotal (below tier 1): subtotal feeds the fill, headline stays "Reach"', () => {
    const m = buildProgressModel(config, {
      status: 'no-gift',
      reason: 'below-threshold',
      subtotal: money(25000, 'CAD'), // CA$250, below tier 1 (CA$500)
    })!;
    expect(m.subtotal).toEqual(money(25000, 'CAD')); // available for the fill (was null before)
    expect(m.tiers.some((t) => t.reached)).toBe(false); // still below CA$500
    expect(m.next?.tierId).toBe('t1');
    expect(m.next?.spendMore).toBeNull(); // headline stays "Reach CA$500", not "Spend X more"
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

describe('stepperLayout (linear auto-scaled fill, pure)', () => {
  it('nodes sit at threshold / (highest x 4/3) — CA$500/1000/1500 over max 2000 -> 25/50/75%', () => {
    const { nodes } = stepperLayout(buildProgressModel(config, gift('t1', 60000))!);
    expect(nodes.map((n) => Math.round(n.posPct))).toEqual([25, 50, 75]); // top tier at 75%, 25% headroom
    expect(nodes.map((n) => n.align)).toEqual(['center', 'center', 'center']);
  });

  it('auto-scales to ANY tier amounts: a 400/800/1200 campaign still lands 25/50/75% (max 1600)', () => {
    const scaled: CampaignConfigResponse = {
      status: 'active',
      currency: 'CAD',
      declineEnabled: true,
      tiers: [
        {
          tierId: 'a',
          position: 1,
          threshold: money(40000, 'CAD'),
          gift: config.status === 'active' ? config.tiers[0]!.gift : ({} as never),
        },
        {
          tierId: 'b',
          position: 2,
          threshold: money(80000, 'CAD'),
          gift: config.status === 'active' ? config.tiers[0]!.gift : ({} as never),
        },
        {
          tierId: 'c',
          position: 3,
          threshold: money(120000, 'CAD'),
          gift: config.status === 'active' ? config.tiers[0]!.gift : ({} as never),
        },
      ],
    };
    const { fillPct, nodes } = stepperLayout(buildProgressModel(scaled, gift('c', 120000))!);
    expect(nodes.map((n) => Math.round(n.posPct))).toEqual([25, 50, 75]);
    expect(fillPct).toBe(75); // subtotal at the top tier (CA$1200) -> 1200 / 1600 = 75%
  });

  it('fill is subtotal / 2000: CA$250 -> 12.5% (partially filled below tier 1)', () => {
    expect(stepperLayout(buildProgressModel(config, gift('t1', 25000))!).fillPct).toBe(12.5);
  });

  it('CA$1000 -> 50% fill with the CA$1000 node reached', () => {
    const { fillPct, nodes } = stepperLayout(buildProgressModel(config, gift('t2', 100000))!);
    expect(fillPct).toBe(50);
    expect(nodes.find((n) => n.tierId === 't2')!.reached).toBe(true);
  });

  it('fill is 75% at the top tier (CA$1500) — headroom remains up to CA$2000', () => {
    expect(stepperLayout(buildProgressModel(config, gift('t3', 150000))!).fillPct).toBe(75);
  });

  it('fill clamps at 100% above CA$2000', () => {
    expect(stepperLayout(buildProgressModel(config, gift('t3', 250000))!).fillPct).toBe(100);
  });

  it('fill is 0 when the server has not confirmed a subtotal (no-gift without subtotal)', () => {
    const m = buildProgressModel(config, { status: 'no-gift', reason: 'inactive' })!;
    expect(stepperLayout(m).fillPct).toBe(0);
  });

  it('no-gift WITH a confirmed subtotal still fills (CA$250 -> 12.5%, below tier 1)', () => {
    const m = buildProgressModel(config, {
      status: 'no-gift',
      reason: 'below-threshold',
      subtotal: money(25000, 'CAD'),
    })!;
    expect(stepperLayout(m).fillPct).toBe(12.5);
  });
});
