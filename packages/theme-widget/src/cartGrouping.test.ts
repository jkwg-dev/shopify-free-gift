import { describe, expect, it } from 'vitest';
import { classifyAndGroup, type RawCartLine } from './cartGrouping.js';

const OUR = 'OURCODE';

function line(over: Partial<RawCartLine> & Pick<RawCartLine, 'index' | 'variantId'>): RawCartLine {
  return {
    key: `k${over.index}`,
    quantity: 1,
    finalLinePrice: 1000,
    originalLinePrice: 1000,
    marked: false,
    allocationTitles: [],
    ...over,
  };
}

const gift = (index: number, variantId: number): RawCartLine =>
  line({ index, variantId, quantity: 1, finalLinePrice: 0, marked: true, allocationTitles: [OUR] });

describe('classifyAndGroup', () => {
  it('no gifts -> empty gets/lingering, hasGifts false', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 })], OUR);
    expect(plan.hasGifts).toBe(false);
    expect(plan.gets).toEqual([]);
    expect(plan.lingering).toEqual([]);
    expect(plan.lineCount).toBe(1);
  });

  it('split buy lines (same variant) are not merged — only gift lines are classified', () => {
    const plan = classifyAndGroup(
      [
        line({
          index: 0,
          variantId: 1,
          quantity: 5,
          finalLinePrice: 5000,
          originalLinePrice: 5000,
        }),
        line({
          index: 1,
          variantId: 1,
          quantity: 2,
          finalLinePrice: 2000,
          originalLinePrice: 2000,
        }),
      ],
      OUR,
    );
    expect(plan.gets).toEqual([]);
    expect(plan.lingering).toEqual([]);
    expect(plan.hasGifts).toBe(false);
    expect(plan.lineCount).toBe(2);
  });

  it('a single qualifying gift -> one gets line', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1, quantity: 2 }), gift(1, 9)], OUR);
    expect(plan.gets).toEqual([{ index: 1, key: 'k1', variantId: 9 }]);
    expect(plan.hasGifts).toBe(true);
  });

  it('AND tier — every zeroed gift variant is gets', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 }), gift(1, 8), gift(2, 9)], OUR);
    expect(plan.gets.map((g) => g.variantId)).toEqual([8, 9]);
  });

  it('issue #6 — $0 line with our allocation is gets; paid marked line is not hidden', () => {
    const zeroed = line({
      index: 0,
      variantId: 9,
      finalLinePrice: 0,
      marked: false,
      allocationTitles: [OUR],
    });
    const paidMarked = line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true });
    const plan = classifyAndGroup([zeroed, paidMarked], OUR);
    expect(plan.gets).toEqual([{ index: 0, key: 'k0', variantId: 9 }]);
    expect(plan.lingering).toEqual([]);
  });

  it('lingering — marked, not zeroed, no zeroed sibling', () => {
    const plan = classifyAndGroup(
      [
        line({ index: 0, variantId: 1 }),
        line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true }),
      ],
      OUR,
    );
    expect(plan.lingering).toEqual([{ index: 1, key: 'k1', variantId: 9 }]);
    expect(plan.gets).toEqual([]);
    expect(plan.hasGifts).toBe(true);
  });

  it('scoped to OUR code — a $0 line from another discount is not gets', () => {
    const otherZero = line({
      index: 0,
      variantId: 1,
      finalLinePrice: 0,
      allocationTitles: ['KITE_BOGO'],
    });
    const plan = classifyAndGroup([otherZero], OUR);
    expect(plan.gets).toEqual([]);
  });

  it('no applied code — marked-but-unzeroed line is lingering', () => {
    const plan = classifyAndGroup(
      [line({ index: 0, variantId: 9, finalLinePrice: 1000, marked: true, allocationTitles: [] })],
      null,
    );
    expect(plan.gets).toEqual([]);
    expect(plan.lingering.map((l) => l.variantId)).toEqual([9]);
  });
});
