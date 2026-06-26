import { describe, expect, it } from 'vitest';
import { giftRowTargets, type CartItemLike } from './cartDrawer.js';

const item = (variant_id: number, gift: boolean): CartItemLike => ({
  variant_id,
  properties: gift ? { _fge_gift: '1' } : {},
});

describe('giftRowTargets (which cart rows to hide)', () => {
  it('returns the 1-based index + variant id of ONLY app-added gift lines', () => {
    const items = [
      item(1000, false), // paid (Hydrogen) — keep
      item(2001, true), // gift (Ice) — hide
      item(3001, false), // paid — keep
      item(3002, true), // gift — hide
    ];
    expect(giftRowTargets(items)).toEqual([
      { index1: 2, variantId: 2001 },
      { index1: 4, variantId: 3002 },
    ]);
  });

  it('does not target a non-gift line even if it shares a gift variant id (per-line, not per-variant)', () => {
    // A paid duplicate of a gift variant (model C) must stay visible; only the app-added line is hidden.
    const items = [item(2001, false), item(2001, true)];
    expect(giftRowTargets(items)).toEqual([{ index1: 2, variantId: 2001 }]);
  });

  it('treats null / empty properties as non-gift', () => {
    const items: CartItemLike[] = [
      { variant_id: 1, properties: null },
      { variant_id: 2, properties: {} },
    ];
    expect(giftRowTargets(items)).toEqual([]);
  });
});
