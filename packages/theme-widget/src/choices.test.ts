import { describe, expect, it } from 'vitest';
import { groupGiftOptionsByProduct, type GiftOptionView } from './choices.js';

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
