import { describe, expect, it } from 'vitest';
import {
  hasPublicationsScope,
  MissingPublicationConfigError,
  ONLINE_STORE_PUBLICATION_ENV,
  requireOnlineStorePublicationId,
} from './publicationConfig.js';

const VALID = 'gid://shopify/Publication/157545496685';

describe('requireOnlineStorePublicationId', () => {
  it('returns a valid Online Store publication GID', () => {
    expect(requireOnlineStorePublicationId({ [ONLINE_STORE_PUBLICATION_ENV]: VALID })).toBe(VALID);
  });

  it('trims surrounding whitespace', () => {
    expect(
      requireOnlineStorePublicationId({ [ONLINE_STORE_PUBLICATION_ENV]: `  ${VALID}  ` }),
    ).toBe(VALID);
  });

  it('throws a NAMED error when unset (never silently skips the publication check)', () => {
    expect(() => requireOnlineStorePublicationId({})).toThrow(MissingPublicationConfigError);
  });

  it('throws when empty/whitespace-only', () => {
    expect(() =>
      requireOnlineStorePublicationId({ [ONLINE_STORE_PUBLICATION_ENV]: '   ' }),
    ).toThrow(MissingPublicationConfigError);
  });

  it('throws when malformed (not a Publication GID)', () => {
    for (const bad of [
      '157545496685',
      'gid://shopify/Collection/1',
      'gid://shopify/Publication/',
      'gid://shopify/Publication/abc',
    ]) {
      expect(() =>
        requireOnlineStorePublicationId({ [ONLINE_STORE_PUBLICATION_ENV]: bad }),
      ).toThrow(MissingPublicationConfigError);
    }
  });
});

describe('hasPublicationsScope', () => {
  it('is true when the granted scope CSV includes read_publications (trim-tolerant)', () => {
    expect(hasPublicationsScope('read_products,write_discounts,read_publications')).toBe(true);
    expect(hasPublicationsScope(' read_products , read_publications ')).toBe(true);
  });

  it('is false when read_publications is absent (the stock-only fallback condition)', () => {
    expect(
      hasPublicationsScope('read_products,write_products,write_discounts,read_discounts'),
    ).toBe(false);
    expect(hasPublicationsScope('')).toBe(false);
  });
});
