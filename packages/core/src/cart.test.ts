import { describe, expect, it } from 'vitest';
import { computeQualifyingSubtotal, type CartLine } from './cart.js';
import { CurrencyMismatchError, money } from './money.js';

const line = (overrides: Partial<CartLine>): CartLine => ({
  variantId: 'v-default',
  unitPrice: money(1000, 'USD'),
  quantity: 1,
  isGift: false,
  ...overrides,
});

describe('computeQualifyingSubtotal', () => {
  it('sums non-gift lines by unit price * quantity', () => {
    const subtotal = computeQualifyingSubtotal(
      [
        line({ unitPrice: money(1500, 'USD'), quantity: 2 }),
        line({ unitPrice: money(500, 'USD'), quantity: 1 }),
      ],
      'USD',
    );
    expect(subtotal).toEqual(money(3500, 'USD'));
  });

  it('returns zero for an empty cart', () => {
    expect(computeQualifyingSubtotal([], 'USD')).toEqual(money(0, 'USD'));
  });

  it('EXCLUDES gift lines from the qualifying subtotal', () => {
    // A gift priced at 4000 sits in the cart but must not count toward qualification —
    // otherwise it could bump the cart into a higher tier (see resolve.test.ts).
    const subtotal = computeQualifyingSubtotal(
      [
        line({ variantId: 'paid', unitPrice: money(2000, 'USD'), quantity: 1 }),
        line({ variantId: 'gift', unitPrice: money(4000, 'USD'), quantity: 1, isGift: true }),
      ],
      'USD',
    );
    expect(subtotal).toEqual(money(2000, 'USD'));
  });

  it('returns zero when the only line is a gift', () => {
    const subtotal = computeQualifyingSubtotal(
      [line({ unitPrice: money(4000, 'USD'), isGift: true })],
      'USD',
    );
    expect(subtotal).toEqual(money(0, 'USD'));
  });

  it('throws when a line is priced in a different currency than the campaign', () => {
    expect(() =>
      computeQualifyingSubtotal([line({ unitPrice: money(1000, 'EUR') })], 'USD'),
    ).toThrow(CurrencyMismatchError);
  });

  it('EXCLUDES lines NOT in the qualifying collection (inQualifyingCollection=false)', () => {
    const subtotal = computeQualifyingSubtotal(
      [
        line({
          variantId: 'in-collection',
          unitPrice: money(3000, 'USD'),
          inQualifyingCollection: true,
        }),
        line({
          variantId: 'not-in-collection',
          unitPrice: money(2000, 'USD'),
          inQualifyingCollection: false,
        }),
      ],
      'USD',
    );
    expect(subtotal).toEqual(money(3000, 'USD'));
  });

  it('EXCLUDES lines with a discount allocation (BOGO, automatic discount, etc.)', () => {
    const subtotal = computeQualifyingSubtotal(
      [
        line({ variantId: 'full-price', unitPrice: money(3000, 'USD'), quantity: 1 }),
        line({
          variantId: 'bogo-item',
          unitPrice: money(2000, 'USD'),
          quantity: 1,
          hasDiscountAllocation: true,
        }),
      ],
      'USD',
    );
    expect(subtotal).toEqual(money(3000, 'USD'));
  });

  it('counts only qualifying full-price lines: excludes gifts, out-of-collection, and discounted', () => {
    const subtotal = computeQualifyingSubtotal(
      [
        line({ variantId: 'A', unitPrice: money(5000, 'USD'), inQualifyingCollection: true }), // in collection, full price ✓
        line({
          variantId: 'B',
          unitPrice: money(3000, 'USD'),
          inQualifyingCollection: true,
          hasDiscountAllocation: true,
        }), // in collection but BOGO ✗
        line({ variantId: 'C', unitPrice: money(4000, 'USD'), inQualifyingCollection: false }), // not in collection ✗
        line({ variantId: 'D', unitPrice: money(2000, 'USD'), isGift: true }), // gift ✗
      ],
      'USD',
    );
    expect(subtotal).toEqual(money(5000, 'USD'));
  });

  it('treats inQualifyingCollection=true as qualifying (included)', () => {
    const subtotal = computeQualifyingSubtotal(
      [line({ unitPrice: money(1000, 'USD'), inQualifyingCollection: true })],
      'USD',
    );
    expect(subtotal).toEqual(money(1000, 'USD'));
  });

  it('treats hasDiscountAllocation=false as full-price (not excluded)', () => {
    const subtotal = computeQualifyingSubtotal(
      [line({ unitPrice: money(1000, 'USD'), hasDiscountAllocation: false })],
      'USD',
    );
    expect(subtotal).toEqual(money(1000, 'USD'));
  });

  it('treats undefined flags as qualifying (backward compat — no collection check)', () => {
    const subtotal = computeQualifyingSubtotal([line({ unitPrice: money(1000, 'USD') })], 'USD');
    expect(subtotal).toEqual(money(1000, 'USD'));
  });
});
