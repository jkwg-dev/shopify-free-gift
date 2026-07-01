import { money, type GiftItemView, type TierConfig } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import {
  choicesFromCart,
  defaultGiftChoices,
  groupAndGiftsByProduct,
  groupGiftOptionsByProduct,
  type GiftOptionView,
} from './choices.js';

const completeSnowboard = 'gid://shopify/Product/COMPLETE';
const liquid = 'gid://shopify/Product/LIQUID';

const options: GiftOptionView[] = [
  {
    optionId: 'a',
    variantId: 'v/ICE',
    productId: completeSnowboard,
    variantLabel: 'Ice',
    available: true,
  },
  {
    optionId: 'b',
    variantId: 'v/DAWN',
    productId: completeSnowboard,
    variantLabel: 'Dawn',
    available: true,
  },
  { optionId: 'opt-1', variantId: 'v/S', productId: liquid, variantLabel: 'S', available: true },
  { optionId: 'opt-3', variantId: 'v/L', productId: liquid, variantLabel: 'L', available: false },
];

describe('groupGiftOptionsByProduct', () => {
  it('groups sibling variants under one product without dedup', () => {
    const groups = groupGiftOptionsByProduct(options);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.productId).toBe(completeSnowboard);
    expect(groups[0]!.options.map((o) => o.variantLabel)).toEqual(['Ice', 'Dawn']);
    expect(groups[1]!.options.map((o) => o.variantLabel)).toEqual(['S', 'L']);
  });

  it('preserves each variant as a distinct selectable option', () => {
    const groups = groupGiftOptionsByProduct(options);
    const total = groups.reduce((n, g) => n + g.options.length, 0);
    expect(total).toBe(4);
  });

  it('carries per-variant availability so 5b can disable an out-of-stock variant', () => {
    const liquidGroup = groupGiftOptionsByProduct(options).find((g) => g.productId === liquid);
    expect(liquidGroup?.options.find((o) => o.variantLabel === 'L')?.available).toBe(false);
    expect(liquidGroup?.options.find((o) => o.variantLabel === 'S')?.available).toBe(true);
  });

  it('returns one single-option group for a single-variant product', () => {
    const single = groupGiftOptionsByProduct([options[2]!]);
    expect(single).toHaveLength(1);
    expect(single[0]!.options).toHaveLength(1);
  });
});

describe('defaultGiftChoices', () => {
  it('picks the first AVAILABLE option per OR tier (gift included by default)', () => {
    const tiers: TierConfig[] = [
      {
        tierId: 't1',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'OR', options: options.slice(0, 2) }, // Ice (avail), Dawn (avail)
      },
    ];
    expect(defaultGiftChoices(tiers)).toEqual({ t1: 'a' });
  });

  it('skips an out-of-stock first option and selects the first available', () => {
    const tiers: TierConfig[] = [
      {
        tierId: 't1',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: {
          kind: 'OR',
          options: [options[3]!, options[2]!], // L (unavailable), then S (available)
        },
      },
    ];
    expect(defaultGiftChoices(tiers)).toEqual({ t1: 'opt-1' }); // S, the first available
  });

  it('skips AND tiers with no gifts', () => {
    const tiers: TierConfig[] = [
      {
        tierId: 'tAnd',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'AND', gifts: [] },
      },
      {
        tierId: 'tOr',
        position: 2,
        threshold: money(10000, 'USD'),
        gift: { kind: 'OR', options: [options[0]!] },
      },
    ];
    expect(defaultGiftChoices(tiers)).toEqual({ tOr: 'a' });
  });

  it('generates compound keys for AND tiers (one per product, first available variant)', () => {
    const andGifts: GiftItemView[] = [
      { variantId: 'v/ICE', productId: completeSnowboard, variantLabel: 'Ice', available: false },
      { variantId: 'v/DAWN', productId: completeSnowboard, variantLabel: 'Dawn', available: true },
      { variantId: 'v/S', productId: liquid, variantLabel: 'S', available: true },
    ];
    const tiers: TierConfig[] = [
      {
        tierId: 'tAnd',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'AND', gifts: andGifts },
      },
    ];
    expect(defaultGiftChoices(tiers)).toEqual({
      [`tAnd:${completeSnowboard}`]: 'v/DAWN',
      [`tAnd:${liquid}`]: 'v/S',
    });
  });

  it('AND tier falls back to first variant when none are available', () => {
    const andGifts: GiftItemView[] = [
      { variantId: 'v/ICE', productId: completeSnowboard, variantLabel: 'Ice', available: false },
      { variantId: 'v/DAWN', productId: completeSnowboard, variantLabel: 'Dawn', available: false },
    ];
    const tiers: TierConfig[] = [
      {
        tierId: 'tAnd',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'AND', gifts: andGifts },
      },
    ];
    expect(defaultGiftChoices(tiers)).toEqual({
      [`tAnd:${completeSnowboard}`]: 'v/ICE',
    });
  });

  it('mixed OR and AND tiers produce both simple and compound keys', () => {
    const andGifts: GiftItemView[] = [
      { variantId: 'v/S', productId: liquid, variantLabel: 'S', available: true },
    ];
    const tiers: TierConfig[] = [
      {
        tierId: 't1',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'OR', options: options.slice(0, 2) },
      },
      {
        tierId: 't2',
        position: 2,
        threshold: money(10000, 'USD'),
        gift: { kind: 'AND', gifts: andGifts },
      },
    ];
    const result = defaultGiftChoices(tiers);
    expect(result['t1']).toBe('a');
    expect(result[`t2:${liquid}`]).toBe('v/S');
  });
});

describe('choicesFromCart', () => {
  const orTiers: TierConfig[] = [
    {
      tierId: 't1',
      position: 1,
      threshold: money(5000, 'USD'),
      gift: { kind: 'OR', options: options.slice(0, 2) }, // Ice (v/ICE), Dawn (v/DAWN)
    },
  ];

  it('recovers the OR selection from the cart gift-line variant (not the default)', () => {
    // The default is 'a' (Ice); the cart holds the DAWN variant → the choice must be 'b'.
    expect(choicesFromCart(orTiers, new Set(['v/DAWN']))).toEqual({ t1: 'b' });
  });

  it('returns nothing for a tier whose variant is not in the cart (caller falls back to default)', () => {
    expect(choicesFromCart(orTiers, new Set(['v/UNKNOWN']))).toEqual({});
  });

  it('recovers AND per-product picks as compound keys', () => {
    const andGifts: GiftItemView[] = [
      { variantId: 'v/ICE', productId: completeSnowboard, variantLabel: 'Ice', available: true },
      { variantId: 'v/DAWN', productId: completeSnowboard, variantLabel: 'Dawn', available: true },
      { variantId: 'v/S', productId: liquid, variantLabel: 'S', available: true },
    ];
    const tiers: TierConfig[] = [
      {
        tierId: 'tAnd',
        position: 1,
        threshold: money(5000, 'USD'),
        gift: { kind: 'AND', gifts: andGifts },
      },
    ];
    // Cart holds DAWN (of the snowboard) + S (of liquid).
    expect(choicesFromCart(tiers, new Set(['v/DAWN', 'v/S']))).toEqual({
      [`tAnd:${completeSnowboard}`]: 'v/DAWN',
      [`tAnd:${liquid}`]: 'v/S',
    });
  });

  it('layered over defaults, the cart choice wins where present and defaults fill the rest', () => {
    const tiers: TierConfig[] = [
      ...orTiers,
      {
        tierId: 't2',
        position: 2,
        threshold: money(10000, 'USD'),
        gift: { kind: 'OR', options: [options[2]!, options[3]!] }, // S (default), L
      },
    ];
    const merged = { ...defaultGiftChoices(tiers), ...choicesFromCart(tiers, new Set(['v/DAWN'])) };
    expect(merged['t1']).toBe('b'); // cart pick (Dawn) overrides the default (Ice)
    expect(merged['t2']).toBe('opt-1'); // no cart line for t2 → default (S)
  });
});

describe('groupAndGiftsByProduct', () => {
  const andGifts: GiftItemView[] = [
    {
      variantId: 'v/ICE',
      productId: completeSnowboard,
      productLabel: 'Complete Snowboard',
      variantLabel: 'Ice',
      available: true,
    },
    {
      variantId: 'v/DAWN',
      productId: completeSnowboard,
      productLabel: 'Complete Snowboard',
      variantLabel: 'Dawn',
      available: true,
    },
    {
      variantId: 'v/S',
      productId: liquid,
      productLabel: 'Liquid',
      variantLabel: 'S',
      available: true,
    },
  ];

  it('groups by product, preserving insertion order', () => {
    const groups = groupAndGiftsByProduct(andGifts);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.productId).toBe(completeSnowboard);
    expect(groups[0]!.productLabel).toBe('Complete Snowboard');
    expect(groups[0]!.variants.map((v) => v.variantLabel)).toEqual(['Ice', 'Dawn']);
    expect(groups[1]!.productId).toBe(liquid);
    expect(groups[1]!.variants).toHaveLength(1);
  });

  it('returns empty for no gifts', () => {
    expect(groupAndGiftsByProduct([])).toEqual([]);
  });
});
