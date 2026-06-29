import { describe, expect, it } from 'vitest';
import { giftOfferability } from './giftAvailability.js';

// Fully offerable baseline; each case flips one signal.
const OK = { resolved: true, priced: true, publishedToOnlineStore: true, inStock: true } as const;

describe('giftOfferability', () => {
  it('is offerable when every signal holds (with a market context)', () => {
    expect(giftOfferability(OK)).toEqual({ offerable: true, reason: null });
  });

  it('is offerable without a market context (priced omitted -> never unpriced)', () => {
    expect(
      giftOfferability({ resolved: true, publishedToOnlineStore: true, inStock: true }),
    ).toEqual({ offerable: true, reason: null });
  });

  it('reports unresolved for a deleted variant', () => {
    expect(giftOfferability({ ...OK, resolved: false })).toEqual({
      offerable: false,
      reason: 'unresolved',
    });
  });

  it('reports unpriced when a market context is given but the variant is not priced', () => {
    expect(giftOfferability({ ...OK, priced: false })).toEqual({
      offerable: false,
      reason: 'unpriced',
    });
  });

  it('reports not-published for an in-stock-but-unpublished gift (the /cart/add 422 leak)', () => {
    expect(giftOfferability({ ...OK, publishedToOnlineStore: false })).toEqual({
      offerable: false,
      reason: 'not-published',
    });
  });

  it('reports out-of-stock when published but availableForSale is false', () => {
    expect(giftOfferability({ ...OK, inStock: false })).toEqual({
      offerable: false,
      reason: 'out-of-stock',
    });
  });

  // Precedence: most-fundamental signal wins so the reported reason is the root cause.
  it('prefers unresolved over every other failing signal', () => {
    expect(
      giftOfferability({
        resolved: false,
        priced: false,
        publishedToOnlineStore: false,
        inStock: false,
      }).reason,
    ).toBe('unresolved');
  });

  it('prefers unpriced over not-published/out-of-stock', () => {
    expect(
      giftOfferability({
        resolved: true,
        priced: false,
        publishedToOnlineStore: false,
        inStock: false,
      }).reason,
    ).toBe('unpriced');
  });

  it('prefers not-published over out-of-stock', () => {
    expect(
      giftOfferability({
        resolved: true,
        priced: true,
        publishedToOnlineStore: false,
        inStock: false,
      }).reason,
    ).toBe('not-published');
  });
});
