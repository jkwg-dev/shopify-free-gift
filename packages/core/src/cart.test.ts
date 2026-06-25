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
});
