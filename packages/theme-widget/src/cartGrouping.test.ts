import { describe, expect, it } from 'vitest';
import {
  classifyAndGroup,
  giftLineKeysToRemove,
  mergeBuysByVariant,
  type RawCartLine,
} from './cartGrouping.js';

const OUR = 'OURCODE';

// Builder with sensible defaults; override per case.
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

// A realized gift: zeroed by OUR code (and normally also marked).
const gift = (index: number, variantId: number): RawCartLine =>
  line({ index, variantId, quantity: 1, finalLinePrice: 0, marked: true, allocationTitles: [OUR] });

describe('classifyAndGroup', () => {
  it('no gifts -> buys only, hasGifts false (drives the no-header state)', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 })], OUR);
    expect(plan.hasGifts).toBe(false);
    expect(plan.gets).toEqual([]);
    expect(plan.lingering).toEqual([]);
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0]).toMatchObject({
      variantId: 1,
      controllableQuantity: 1,
      interactiveIndex: 0,
      hideIndexes: [],
      readOnlyIndexes: [],
      split: false,
    });
    expect(plan.lineCount).toBe(1);
  });

  it('defect #1 — merges a Shopify-split buy variant into one row (combined qty + price)', () => {
    // 7 Hydrogen split 5 + 2; neither zeroed, neither marked -> one merged buy row.
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
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0]).toMatchObject({
      variantId: 1,
      controllableQuantity: 7,
      controllableFinalPrice: 7000,
      controllableOriginalPrice: 7000,
      interactiveIndex: 0,
      hideIndexes: [1],
      readOnlyIndexes: [],
      writableKeys: ['k0', 'k1'],
      split: true,
    });
  });

  it('a single qualifying gift (highest-tier-only) -> one gets line, separate from buys', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1, quantity: 2 }), gift(1, 9)], OUR);
    expect(plan.gets).toEqual([{ index: 1, key: 'k1', variantId: 9 }]);
    expect(plan.buys.map((b) => b.variantId)).toEqual([1]);
    expect(plan.hasGifts).toBe(true);
  });

  it('AND tier — every zeroed gift variant is gets (one code grants them together)', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 }), gift(1, 8), gift(2, 9)], OUR);
    expect(plan.gets.map((g) => g.variantId)).toEqual([8, 9]);
    expect(plan.buys.map((b) => b.variantId)).toEqual([1]);
  });

  it('issue #6 — gift variant also bought full-price: $0 line is gets, paid line is a buy', () => {
    // variant 9 bought 1 full-price + got 1 free; the $0 line carries our allocation (it is the gift),
    // the marker MIGRATED to the full-price line. Allocation-primary classification must put the $0
    // line in gets and the full-price marked line in BUYS — never backwards.
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
    expect(plan.lingering).toEqual([]); // NOT lingering — it has a zeroed sibling
    expect(plan.buys).toHaveLength(1);
    // §M issue-#6 × controllable units: the marked paid line is read-only, controllable=0, so the
    // interactive row never renders for it and a +/-/delete can't no-op against a reconcile-owned line.
    expect(plan.buys[0]).toMatchObject({
      variantId: 9,
      controllableQuantity: 0,
      controllableFinalPrice: 0,
      interactiveIndex: null,
      hideIndexes: [],
      readOnlyIndexes: [1],
      split: false,
    });
    // write-safety: the marked paid line's key is EXCLUDED from writableKeys (reconcile owns it).
    expect(plan.buys[0]!.writableKeys).toEqual([]);
  });

  it('§M — variant bought paid (unmarked) AND a marked overlap unit: controllable row + read-only line', () => {
    // Worst-case model-C residual: variant 9 has a genuine paid unit (unmarked) PLUS a marked unit the
    // gift marker migrated onto. The interactive merged row drives ONLY the unmarked paid unit; the
    // marked unit is surfaced read-only and never written.
    const paidUnmarked = line({ index: 0, variantId: 9, quantity: 2, finalLinePrice: 2000 });
    const paidMarked = line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true });
    const plan = classifyAndGroup([paidUnmarked, paidMarked, gift(2, 9)], OUR);
    expect(plan.gets.map((g) => g.variantId)).toEqual([9]);
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0]).toMatchObject({
      variantId: 9,
      controllableQuantity: 2,
      controllableFinalPrice: 2000,
      interactiveIndex: 0,
      hideIndexes: [],
      readOnlyIndexes: [1],
      writableKeys: ['k0'],
      split: false,
    });
  });

  it('lingering — marked, not zeroed, no zeroed sibling -> "pending" gets, never a buy', () => {
    const plan = classifyAndGroup(
      [
        line({ index: 0, variantId: 1 }),
        line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true }),
      ],
      OUR,
    );
    expect(plan.lingering).toEqual([{ index: 1, key: 'k1', variantId: 9 }]);
    expect(plan.gets).toEqual([]);
    expect(plan.buys.map((b) => b.variantId)).toEqual([1]); // the lingering gift is NOT merged into buys
    expect(plan.hasGifts).toBe(true);
  });

  it('scoped to OUR code — a $0 line discounted by a DIFFERENT code (e.g. Kite) is a buy, not a gift', () => {
    const otherZero = line({
      index: 0,
      variantId: 1,
      finalLinePrice: 0,
      allocationTitles: ['KITE_BOGO'],
    });
    const plan = classifyAndGroup([otherZero], OUR);
    expect(plan.gets).toEqual([]);
    expect(plan.buys.map((b) => b.variantId)).toEqual([1]);
  });

  it('no applied code (ourCode null) — nothing is gets; a marked-but-unzeroed line is lingering', () => {
    const plan = classifyAndGroup(
      [line({ index: 0, variantId: 9, finalLinePrice: 1000, marked: true, allocationTitles: [] })],
      null,
    );
    expect(plan.gets).toEqual([]);
    expect(plan.lingering.map((l) => l.variantId)).toEqual([9]);
  });
});

describe('giftLineKeysToRemove (defect B — gift-first atomic removal key set)', () => {
  it('common case: returns the realized $0 gift key', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1, quantity: 2 }), gift(1, 9)], OUR);
    expect(giftLineKeysToRemove(plan)).toEqual(['k1']);
  });

  it('AND tier: returns BOTH gift keys (removed together in one atomic update)', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 }), gift(1, 8), gift(2, 9)], OUR);
    expect(giftLineKeysToRemove(plan)).toEqual(['k1', 'k2']);
  });

  it('lingering gift (pending, not yet $0) is included', () => {
    const plan = classifyAndGroup(
      [
        line({ index: 0, variantId: 1 }),
        line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true }),
      ],
      OUR,
    );
    expect(giftLineKeysToRemove(plan)).toEqual(['k1']);
  });

  it('issue-#6: the MARKED paid unit is EXCLUDED — only the $0 gets key is returned', () => {
    const zeroed = line({
      index: 0,
      variantId: 9,
      finalLinePrice: 0,
      marked: false,
      allocationTitles: [OUR],
    });
    const paidMarked = line({ index: 1, variantId: 9, finalLinePrice: 1000, marked: true });
    const plan = classifyAndGroup([zeroed, paidMarked], OUR);
    // k1 (the marked paid unit) must NOT be in the removal set — it is a purchase, not the gift.
    expect(giftLineKeysToRemove(plan)).toEqual(['k0']);
    expect(plan.buys[0]!.readOnlyIndexes).toEqual([1]);
  });

  it('no gift lines => empty set (so the gift-first retry never fires)', () => {
    const plan = classifyAndGroup([line({ index: 0, variantId: 1 })], OUR);
    expect(giftLineKeysToRemove(plan)).toEqual([]);
  });
});

describe('mergeBuysByVariant', () => {
  it('preserves first-occurrence order and sums per variant', () => {
    const rows = mergeBuysByVariant([
      line({ index: 0, variantId: 2, quantity: 1, finalLinePrice: 500 }),
      line({ index: 1, variantId: 1, quantity: 3, finalLinePrice: 3000 }),
      line({ index: 2, variantId: 2, quantity: 4, finalLinePrice: 2000 }),
    ]);
    expect(rows.map((r) => r.variantId)).toEqual([2, 1]); // first-occurrence order
    expect(rows[0]).toMatchObject({
      variantId: 2,
      controllableQuantity: 5,
      controllableFinalPrice: 2500,
      interactiveIndex: 0,
      hideIndexes: [2],
      split: true,
    });
    expect(rows[1]).toMatchObject({ variantId: 1, controllableQuantity: 3, split: false });
  });
});
