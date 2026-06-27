import { describe, expect, it } from 'vitest';
import { flattenPickedVariantIds } from './pickedVariants.js';

describe('flattenPickedVariantIds', () => {
  it('flattens selected variants across products, preserving order', () => {
    expect(
      flattenPickedVariantIds([
        { id: 'p/complete', variants: [{ id: 'v/ice' }, { id: 'v/dawn' }] },
        { id: 'p/tee', variants: [{ id: 'v/tee' }] },
      ]),
    ).toEqual(['v/ice', 'v/dawn', 'v/tee']);
  });

  it('handles a single-variant product (one variant returned)', () => {
    expect(flattenPickedVariantIds([{ id: 'p/tee', variants: [{ id: 'v/tee' }] }])).toEqual([
      'v/tee',
    ]);
  });

  it('de-duplicates a variant selected via two products / repeated picks', () => {
    expect(
      flattenPickedVariantIds([
        { id: 'p/a', variants: [{ id: 'v/x' }, { id: 'v/y' }] },
        { id: 'p/a', variants: [{ id: 'v/x' }] },
      ]),
    ).toEqual(['v/x', 'v/y']);
  });

  it('skips a product with no selected variants (missing or empty array)', () => {
    expect(
      flattenPickedVariantIds([
        { id: 'p/none' },
        { id: 'p/empty', variants: [] },
        { id: 'p/one', variants: [{ id: 'v/1' }] },
      ]),
    ).toEqual(['v/1']);
  });

  it('returns [] for an empty selection', () => {
    expect(flattenPickedVariantIds([])).toEqual([]);
  });
});
