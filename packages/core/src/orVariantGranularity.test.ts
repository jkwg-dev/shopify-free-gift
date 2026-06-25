import { describe, expect, it } from 'vitest';
import { resolveGiftSet, type GiftConfig } from './gifts.js';
import { configVersionHash, resolvedGiftSetHash } from './minting.js';

// Requirement: an OR tier whose options are SIBLING VARIANTS of one product (e.g. The Complete
// Snowboard "Ice" and "Dawn") must produce DISTINCT selectable options — one per variant. The
// model keys on variant GID only (there is no productId in core), so options can never be
// deduped/collapsed by product. Choosing A vs B must resolve to different variants and therefore
// different scoped codes (different resolvedGiftSetHash / minting key).
const ICE = 'gid://shopify/ProductVariant/ICE';
const DAWN = 'gid://shopify/ProductVariant/DAWN';

const siblingOr: GiftConfig = {
  kind: 'OR',
  options: [
    { id: 'a', variantId: ICE },
    { id: 'b', variantId: DAWN },
  ],
};

describe('variant-granular OR (sibling variants of one product)', () => {
  it('resolves to exactly the chosen variant, never collapsing siblings', () => {
    expect(resolveGiftSet(siblingOr, 'a')).toEqual([{ variantId: ICE }]);
    expect(resolveGiftSet(siblingOr, 'b')).toEqual([{ variantId: DAWN }]);
    expect(resolveGiftSet(siblingOr, 'a')).not.toEqual(resolveGiftSet(siblingOr, 'b'));
  });

  it('keys the resolved gift-set hash on variant GID -> distinct codes for A vs B', () => {
    const a = resolvedGiftSetHash(resolveGiftSet(siblingOr, 'a'));
    const b = resolvedGiftSetHash(resolveGiftSet(siblingOr, 'b'));
    expect(a).not.toBe(b);
  });

  it('keeps both sibling variants in the config version hash (no product-level dedup)', () => {
    // Removing one sibling variant changes the scope, so the config hash must change — proof the
    // hash sees each variant, not a per-product bucket.
    const both = configVersionHash({
      suppression: 'highest-only',
      tiers: [{ threshold: { amountMinor: 50000, currency: 'CAD' }, gift: siblingOr }],
    });
    const onlyIce = configVersionHash({
      suppression: 'highest-only',
      tiers: [
        {
          threshold: { amountMinor: 50000, currency: 'CAD' },
          gift: { kind: 'OR', options: [{ id: 'a', variantId: ICE }] },
        },
      ],
    });
    expect(both).not.toBe(onlyIce);
  });
});
