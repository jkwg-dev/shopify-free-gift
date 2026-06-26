import { describe, expect, it } from 'vitest';
import { money } from './money.js';
import {
  GIFT_LINE_PROPERTY,
  reconcileGiftLines,
  type CartLineView,
  type GiftReconciliation,
} from './reconcile.js';
import type { ValidateResult } from './validate.js';

const ICE = 'gid://shopify/ProductVariant/ICE';
const DAWN = 'gid://shopify/ProductVariant/DAWN';
const BRUSH = 'gid://shopify/ProductVariant/BRUSH';
const TEE = 'gid://shopify/ProductVariant/TEE';
const PAID = 'gid://shopify/ProductVariant/PAID';

function gift(giftVariantIds: string[], code = 'CODE-1'): ValidateResult {
  return {
    status: 'gift',
    currency: 'CAD',
    subtotal: money(60000, 'CAD'),
    tierId: 't1',
    giftVariantIds,
    code,
    appliedThreshold: money(50000, 'CAD'),
  };
}

function noGift(reason: Extract<ValidateResult, { status: 'no-gift' }>['reason']): ValidateResult {
  return { status: 'no-gift', reason };
}

function giftLine(id: string, variantId: string): CartLineView {
  return { id, variantId, quantity: 1, appAdded: true };
}

function paidLine(id: string, variantId: string, quantity = 1): CartLineView {
  return { id, variantId, quantity, appAdded: false };
}

function variants(r: GiftReconciliation) {
  return {
    add: r.add.map((a) => a.variantId),
    remove: r.remove.map((x) => x.variantId),
    adjust: r.adjust.map((x) => x.variantId),
  };
}

describe('reconcileGiftLines — adds the resolved gift', () => {
  it('adds the gift when none is present, marked app-added, qty 1', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID)], gift([ICE]));
    expect(r.add).toEqual([
      { variantId: ICE, quantity: 1, properties: { [GIFT_LINE_PROPERTY]: '1' } },
    ]);
    expect(r.remove).toEqual([]);
    expect(r.applyCode).toBe('CODE-1');
    expect(r.status).toBe('gift');
    expect(r.reason).toBeNull();
  });

  it('AND tier adds both variants (one code), each at qty 1', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID)], gift([BRUSH, TEE]));
    expect(variants(r).add).toEqual([BRUSH, TEE]);
    expect(r.add.map((a) => a.quantity)).toEqual([1, 1]); // both at qty 1
    expect(r.applyCode).toBe('CODE-1');
  });

  it('AND tier already present is a no-op (both kept once at qty 1)', () => {
    const r = reconcileGiftLines([giftLine('g1', BRUSH), giftLine('g2', TEE)], gift([BRUSH, TEE]));
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.adjust).toEqual([]);
  });

  it('crossing OUT of an AND tier (no-gift) removes BOTH AND variants', () => {
    const r = reconcileGiftLines(
      [giftLine('g1', BRUSH), giftLine('g2', TEE)],
      noGift('below-threshold'),
    );
    expect(new Set(variants(r).remove)).toEqual(new Set([BRUSH, TEE]));
    expect(r.add).toEqual([]);
    expect(r.applyCode).toBeNull();
  });
});

describe('reconcileGiftLines — idempotency', () => {
  it('does nothing when the desired gift is already app-added', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID), giftLine('g1', ICE)], gift([ICE]));
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.adjust).toEqual([]);
    expect(r.applyCode).toBe('CODE-1');
  });
});

describe('reconcileGiftLines — NEVER touches a non-gift line (regression guard)', () => {
  it('leaves a non-gift line at qty 6 completely untouched while still normalizing a gift line', () => {
    // The qualifying product (no _fge_gift) at qty 6 must NEVER be adjusted/removed; a stacked gift
    // line (qty 2) is still normalized to 1. Quantity-fix applies ONLY to app-added gift lines.
    const cart: CartLineView[] = [
      { id: 'hyd', variantId: PAID, quantity: 6, appAdded: false }, // qualifying, qty 6
      { id: 'g1', variantId: ICE, quantity: 2, appAdded: true }, // gift, bumped
    ];
    const r = reconcileGiftLines(cart, gift([ICE]));

    // the non-gift line never appears in ANY mutation
    expect([...r.remove, ...r.adjust].some((x) => x.variantId === PAID)).toBe(false);
    expect(r.add.some((a) => a.variantId === PAID)).toBe(false);
    expect(r.remove.some((x) => x.id === 'hyd')).toBe(false);
    expect(r.adjust.some((x) => x.id === 'hyd')).toBe(false);
    // the gift line is normalized to qty 1
    expect(r.adjust).toEqual([{ id: 'g1', variantId: ICE, quantity: 1 }]);
  });

  it('even when the SAME variant exists as both a paid line (qty 6) and the desired gift, only the gift line is normalized', () => {
    // Pathological config (a variant that is both qualifying-purchased AND a gift): the paid line is
    // still never touched; the gift line (app-added) is the only one normalized.
    const cart: CartLineView[] = [
      { id: 'paidICE', variantId: ICE, quantity: 6, appAdded: false }, // paid, qty 6 — must stay
      { id: 'giftICE', variantId: ICE, quantity: 3, appAdded: true }, // app-added gift, bumped
    ];
    const r = reconcileGiftLines(cart, gift([ICE]));
    expect(r.remove.some((x) => x.id === 'paidICE')).toBe(false);
    expect(r.adjust.some((x) => x.id === 'paidICE')).toBe(false);
    expect(r.adjust).toEqual([{ id: 'giftICE', variantId: ICE, quantity: 1 }]); // only the gift
    expect(r.add).toEqual([]); // gift already present (app-added)
  });
});

describe('reconcileGiftLines — normalization (BUG 1: no stacking / no qty bump)', () => {
  it('collapses a bumped gift quantity back to exactly 1 (does NOT re-add)', () => {
    // A rapid double-add bumped the gift line to qty 2; reconcile must fix it to 1, not add more.
    const bumped: CartLineView = { id: 'g1', variantId: ICE, quantity: 2, appAdded: true };
    const r = reconcileGiftLines([bumped], gift([ICE]));
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.adjust).toEqual([{ id: 'g1', variantId: ICE, quantity: 1 }]);
  });

  it('removes duplicate/split gift lines of the SAME desired variant, keeping exactly one', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE), giftLine('g2', ICE)], gift([ICE]));
    expect(variants(r).remove).toEqual([ICE]); // the second (duplicate) line
    expect(r.remove.map((x) => x.id)).toEqual(['g2']); // keep the first, remove the extra
    expect(r.add).toEqual([]);
    expect(r.adjust).toEqual([]);
  });

  it('keeps the first desired line at qty 1 and removes a bumped duplicate', () => {
    const dupBumped: CartLineView = { id: 'g2', variantId: ICE, quantity: 3, appAdded: true };
    const r = reconcileGiftLines([giftLine('g1', ICE), dupBumped], gift([ICE]));
    expect(r.remove.map((x) => x.id)).toEqual(['g2']); // extra removed
    expect(r.adjust).toEqual([]); // the kept first line is already qty 1
    expect(r.add).toEqual([]);
  });

  it('running again on the normalized result is a no-op (convergent)', () => {
    // After the fix above is applied, the cart is one ICE line at qty 1 -> reconcile yields nothing.
    const r = reconcileGiftLines([giftLine('g1', ICE)], gift([ICE]));
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.adjust).toEqual([]);
  });
});

describe('reconcileGiftLines — highest-tier-only across stacked gifts (BUG 2)', () => {
  it('crossing into tier 3 removes ALL previous-tier gift lines and adds only tier 3', () => {
    // Live bug: tier-2 AND gifts (BRUSH+TEE) AND a stale tier-3 line all present; desired is tier-3.
    const cart = [
      giftLine('g1', BRUSH), // tier-2 AND
      giftLine('g2', TEE), // tier-2 AND
      giftLine('g3', ICE), // a stale lower-tier gift
      paidLine('l1', PAID),
    ];
    const r = reconcileGiftLines(cart, gift([DAWN])); // tier-3 OR resolved to DAWN
    expect(new Set(variants(r).remove)).toEqual(new Set([BRUSH, TEE, ICE]));
    expect(variants(r).add).toEqual([DAWN]);
  });
});

describe('reconcileGiftLines — OR / variant changes', () => {
  it('swaps Ice -> Dawn (sibling variants of one product; no product-level dedup)', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE)], gift([DAWN]));
    expect(variants(r).remove).toEqual([ICE]);
    expect(variants(r).add).toEqual([DAWN]);
  });
});

describe('reconcileGiftLines — tier up/down', () => {
  it('tier up: OR gift -> AND gift-set (remove old, add both)', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE)], gift([BRUSH, TEE]));
    expect(variants(r).remove).toEqual([ICE]);
    expect(variants(r).add).toEqual([BRUSH, TEE]);
  });

  it('tier down: AND gift-set -> OR gift (remove both, add one)', () => {
    const r = reconcileGiftLines([giftLine('g1', BRUSH), giftLine('g2', TEE)], gift([ICE]));
    expect(variants(r).remove).toEqual([BRUSH, TEE]);
    expect(variants(r).add).toEqual([ICE]);
  });
});

describe('reconcileGiftLines — decline / re-accept', () => {
  it('decline removes the app-added gift and clears the code', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE)], noGift('declined'));
    expect(variants(r).remove).toEqual([ICE]);
    expect(r.add).toEqual([]);
    expect(r.applyCode).toBeNull();
    expect(r.reason).toBe('declined');
  });

  it('re-accept adds the gift back', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID)], gift([ICE]));
    expect(variants(r).add).toEqual([ICE]);
    expect(r.applyCode).toBe('CODE-1');
  });
});

describe('reconcileGiftLines — drop below threshold', () => {
  it('removes the gift and signals the code no longer applies', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE)], noGift('below-threshold'));
    expect(variants(r).remove).toEqual([ICE]);
    expect(r.applyCode).toBeNull();
    expect(r.reason).toBe('below-threshold');
  });
});

describe('reconcileGiftLines — gift-unavailable', () => {
  it('does not add; removes any stale app-added gift and surfaces the reason', () => {
    const r = reconcileGiftLines([giftLine('g1', ICE)], noGift('gift-unavailable'));
    expect(r.add).toEqual([]);
    expect(variants(r).remove).toEqual([ICE]);
    expect(r.applyCode).toBeNull();
    expect(r.reason).toBe('gift-unavailable');
  });
});

describe('reconcileGiftLines — never touches the shopper’s own lines', () => {
  it('leaves a paid line alone and never removes it', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID)], noGift('below-threshold'));
    expect(r.remove).toEqual([]);
    expect(r.add).toEqual([]);
  });

  it('paid-duplicate: a paid unit of a gift-eligible variant is kept; the gift is still added', () => {
    // Shopper bought ICE as a normal item (no marker). The gift (also ICE) is a SEPARATE app-added
    // line. The paid line is never removed; the gift is added because no app-added ICE exists yet.
    const r = reconcileGiftLines([paidLine('l1', ICE, 2)], gift([ICE]));
    expect(r.remove).toEqual([]); // paid ICE untouched
    expect(variants(r).add).toEqual([ICE]); // gift ICE added as its own app-added line
  });

  it('removes only the app-added gift, not a coexisting paid duplicate, on decline', () => {
    const r = reconcileGiftLines([paidLine('l1', ICE), giftLine('g1', ICE)], noGift('declined'));
    expect(r.remove).toEqual([{ id: 'g1', variantId: ICE }]); // only the app-added one
  });
});
