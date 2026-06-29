import { describe, expect, it } from 'vitest';
import { InvalidGiftChoiceError, resolveGiftSet, type GiftConfig } from './gifts.js';

const andConfig: GiftConfig = {
  kind: 'AND',
  gifts: [{ variantId: 'a' }, { variantId: 'b' }],
};

const orConfig: GiftConfig = {
  kind: 'OR',
  options: [
    { id: 'opt-a', variantId: 'a' },
    { id: 'opt-b', variantId: 'b' },
  ],
};

describe('resolveGiftSet — AND', () => {
  it('returns the full gift-set when no andChoices', () => {
    expect(resolveGiftSet(andConfig, undefined)).toEqual([{ variantId: 'a' }, { variantId: 'b' }]);
  });

  it('returns the full gift-set when andChoices is empty', () => {
    expect(resolveGiftSet(andConfig, undefined, {})).toEqual([
      { variantId: 'a' },
      { variantId: 'b' },
    ]);
  });

  it('filters to chosen variants when andChoices are provided', () => {
    expect(resolveGiftSet(andConfig, undefined, { prod1: 'a' })).toEqual([{ variantId: 'a' }]);
  });

  it('returns all gifts when no chosen variant matches', () => {
    expect(resolveGiftSet(andConfig, undefined, { prod1: 'nonexistent' })).toEqual([
      { variantId: 'a' },
      { variantId: 'b' },
    ]);
  });

  it('filters to exactly the chosen variants from multiple products', () => {
    const multiProduct: GiftConfig = {
      kind: 'AND',
      gifts: [{ variantId: 'a1' }, { variantId: 'a2' }, { variantId: 'b1' }, { variantId: 'b2' }],
    };
    const result = resolveGiftSet(multiProduct, undefined, { prodA: 'a2', prodB: 'b1' });
    expect(result).toEqual([{ variantId: 'a2' }, { variantId: 'b1' }]);
  });

  it('ignores the OR choice param for an AND tier', () => {
    expect(resolveGiftSet(andConfig, 'whatever')).toEqual([{ variantId: 'a' }, { variantId: 'b' }]);
  });
});

describe('resolveGiftSet — OR', () => {
  it('returns exactly the chosen option', () => {
    expect(resolveGiftSet(orConfig, 'opt-b')).toEqual([{ variantId: 'b' }]);
  });

  it('is deterministic for a given choice', () => {
    expect(resolveGiftSet(orConfig, 'opt-a')).toEqual(resolveGiftSet(orConfig, 'opt-a'));
  });

  it('rejects an unknown choice instead of defaulting', () => {
    expect(() => resolveGiftSet(orConfig, 'opt-z')).toThrow(InvalidGiftChoiceError);
  });

  it('rejects a missing choice instead of defaulting', () => {
    expect(() => resolveGiftSet(orConfig, undefined)).toThrow(InvalidGiftChoiceError);
  });

  it('reports the available option ids on rejection', () => {
    try {
      resolveGiftSet(orConfig, 'opt-z');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGiftChoiceError);
      expect((err as InvalidGiftChoiceError).available).toEqual(['opt-a', 'opt-b']);
    }
  });
});
