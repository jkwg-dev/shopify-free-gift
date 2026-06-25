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

  it('AND tier adds both variants (one code)', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID)], gift([BRUSH, TEE]));
    expect(variants(r).add).toEqual([BRUSH, TEE]);
    expect(r.applyCode).toBe('CODE-1');
  });
});

describe('reconcileGiftLines — idempotency', () => {
  it('does nothing when the desired gift is already app-added', () => {
    const r = reconcileGiftLines([paidLine('l1', PAID), giftLine('g1', ICE)], gift([ICE]));
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.applyCode).toBe('CODE-1');
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
