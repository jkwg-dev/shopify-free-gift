import { describe, expect, it } from 'vitest';
import { lineHasRealDiscount } from './discountAllocation.js';

describe('lineHasRealDiscount', () => {
  it('is false for no allocations (full-price line)', () => {
    expect(lineHasRealDiscount(undefined)).toBe(false);
    expect(lineHasRealDiscount([])).toBe(false);
  });

  it('is FALSE for a $0 BXGY "entitled" allocation on a full-price buy line (the oscillation bug)', () => {
    // A qualifying headcover carries the gift code as a $0 entitlement — it is NOT discounted and MUST
    // still count toward the tier. Reading this as "discounted" collapsed the subtotal and tore the
    // gift + code down on every cart change (repro'd from a real /cart.js payload).
    expect(lineHasRealDiscount([{ amount: 0 }])).toBe(false);
  });

  it('is true for a genuine price reduction (amount > 0, e.g. a Kite BOGO / the $0 gift line)', () => {
    expect(lineHasRealDiscount([{ amount: 3400 }])).toBe(true);
  });

  it('is true when ANY allocation reduces the price (mixed $0 entitlement + real reduction)', () => {
    expect(lineHasRealDiscount([{ amount: 0 }, { amount: 500 }])).toBe(true);
  });
});
