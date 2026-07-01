import { describe, expect, it } from 'vitest';
import { planLineMerge, type MergeLine } from './lineMerge.js';

// Full-price line helper: final === original (no real discount).
function full(
  over: Partial<MergeLine> & Pick<MergeLine, 'index' | 'key' | 'variantId'>,
): MergeLine {
  const price = over.finalLinePrice ?? 10000;
  return {
    propertiesKey: '',
    quantity: 1,
    isGift: false,
    finalLinePrice: price,
    originalLinePrice: price,
    ...over,
  };
}

describe('planLineMerge', () => {
  it('returns no groups when every line is unique', () => {
    const plan = planLineMerge([
      full({ index: 0, key: 'a', variantId: 1 }),
      full({ index: 1, key: 'b', variantId: 2 }),
    ]);
    expect(plan.groups).toEqual([]);
  });

  it('merges two full-price lines of the same variant+properties (the BXGY $0-marker split)', () => {
    const plan = planLineMerge([
      full({ index: 0, key: 'buy', variantId: 42, quantity: 2, finalLinePrice: 20000 }),
      full({ index: 1, key: 'marked', variantId: 42, quantity: 1, finalLinePrice: 10000 }),
    ]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toEqual({
      primaryIndex: 0,
      hiddenIndices: [1],
      totalQuantity: 3,
      totalFinalPrice: 30000,
      keys: ['buy', 'marked'],
    });
  });

  it('keeps the lowest index as primary regardless of input order', () => {
    const plan = planLineMerge([
      full({ index: 2, key: 'c', variantId: 7 }),
      full({ index: 0, key: 'a', variantId: 7 }),
      full({ index: 1, key: 'b', variantId: 7 }),
    ]);
    expect(plan.groups[0]?.primaryIndex).toBe(0);
    expect(plan.groups[0]?.hiddenIndices).toEqual([1, 2]);
    expect(plan.groups[0]?.keys).toEqual(['a', 'b', 'c']);
  });

  it('never merges a gift line', () => {
    const plan = planLineMerge([
      full({ index: 0, key: 'paid', variantId: 5 }),
      full({ index: 1, key: 'gift', variantId: 5, isGift: true, finalLinePrice: 0 }),
    ]);
    expect(plan.groups).toEqual([]);
  });

  it('never merges a line whose price is actually reduced (Kite BOGO / any real discount)', () => {
    // Same variant: one full-price buy line + one discounted line. The discounted line stays its own
    // row; the single remaining full-price line has no sibling to merge with.
    const plan = planLineMerge([
      full({ index: 0, key: 'buy', variantId: 9, finalLinePrice: 10000 }),
      {
        index: 1,
        key: 'kite-get',
        variantId: 9,
        propertiesKey: '',
        quantity: 1,
        isGift: false,
        finalLinePrice: 0,
        originalLinePrice: 10000,
      },
    ]);
    expect(plan.groups).toEqual([]);
  });

  it('does not merge same-variant lines with different properties', () => {
    const plan = planLineMerge([
      full({ index: 0, key: 'plain', variantId: 3, propertiesKey: '' }),
      full({ index: 1, key: 'engraved', variantId: 3, propertiesKey: 'text=Hi' }),
    ]);
    expect(plan.groups).toEqual([]);
  });

  it('produces independent groups for two different split products, ordered by primaryIndex', () => {
    const plan = planLineMerge([
      full({ index: 0, key: 'x1', variantId: 100 }),
      full({ index: 1, key: 'y1', variantId: 200 }),
      full({ index: 2, key: 'x2', variantId: 100 }),
      full({ index: 3, key: 'y2', variantId: 200 }),
    ]);
    expect(plan.groups.map((g) => g.primaryIndex)).toEqual([0, 1]);
    expect(plan.groups[0]?.keys).toEqual(['x1', 'x2']);
    expect(plan.groups[1]?.keys).toEqual(['y1', 'y2']);
  });
});
