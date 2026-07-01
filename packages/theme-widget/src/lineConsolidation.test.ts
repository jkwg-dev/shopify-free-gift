import { describe, expect, it } from 'vitest';
import { planLineConsolidation, type ConsolidationLine } from './lineConsolidation.js';

const line = (over: Partial<ConsolidationLine> & { key: string }): ConsolidationLine => ({
  variantId: 100,
  quantity: 1,
  propertiesKey: '',
  isGift: false,
  ...over,
});

describe('planLineConsolidation', () => {
  it('returns null when every variant appears once (nothing to merge)', () => {
    expect(
      planLineConsolidation([
        line({ key: 'a', variantId: 100 }),
        line({ key: 'b', variantId: 200 }),
      ]),
    ).toBeNull();
  });

  it('merges the BXGY split: same variant + properties on two lines -> one line with the total', () => {
    // The exact repro: one allocated line (qty 2) + one plain line (qty 1) of the same product.
    const updates = planLineConsolidation([
      line({ key: 'allocated', variantId: 45121310916798, quantity: 2 }),
      line({ key: 'plain', variantId: 45121310916798, quantity: 1 }),
    ]);
    expect(updates).toEqual({ allocated: 3, plain: 0 }); // first key keeps the total, rest removed
  });

  it('does NOT merge lines of the same variant with DIFFERENT properties', () => {
    expect(
      planLineConsolidation([
        line({ key: 'a', variantId: 100, propertiesKey: 'engrave=AB' }),
        line({ key: 'b', variantId: 100, propertiesKey: 'engrave=CD' }),
      ]),
    ).toBeNull();
  });

  it('never merges gift lines (the app-added $0 unit stays separate from a paid unit)', () => {
    // A gift variant bought full-price (plain) AND received free (_fge_gift). Different properties,
    // and the gift is flagged isGift — so they are two distinct groups, never merged.
    expect(
      planLineConsolidation([
        line({ key: 'paid', variantId: 100, propertiesKey: '', isGift: false }),
        line({ key: 'gift', variantId: 100, propertiesKey: '_fge_gift=1', isGift: true }),
      ]),
    ).toBeNull();
  });

  it('handles three-way splits of one variant', () => {
    expect(
      planLineConsolidation([
        line({ key: 'a', variantId: 100, quantity: 2 }),
        line({ key: 'b', variantId: 100, quantity: 1 }),
        line({ key: 'c', variantId: 100, quantity: 3 }),
      ]),
    ).toEqual({ a: 6, b: 0, c: 0 });
  });

  it('merges multiple distinct variants independently in one pass', () => {
    expect(
      planLineConsolidation([
        line({ key: 'a1', variantId: 100, quantity: 1 }),
        line({ key: 'a2', variantId: 100, quantity: 1 }),
        line({ key: 'b1', variantId: 200, quantity: 2 }),
        line({ key: 'b2', variantId: 200, quantity: 2 }),
      ]),
    ).toEqual({ a1: 2, a2: 0, b1: 4, b2: 0 });
  });
});
