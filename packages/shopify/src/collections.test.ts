import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import {
  collectionProductCount,
  ensureQualifyingCollection,
  QUALIFYING_COLLECTION_HANDLE,
  waitForGiftProductsExcluded,
} from './collections.js';
import { ShopifyUserError } from './errors.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const COLLECTION_GID = 'gid://shopify/Collection/1';

describe('ensureQualifyingCollection', () => {
  it('reuses the existing shared collection (idempotent by handle, no create)', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: {
            collectionByIdentifier: { id: COLLECTION_GID, handle: QUALIFYING_COLLECTION_HANDLE },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await ensureQualifyingCollection(client);

    expect(result.id).toBe(COLLECTION_GID);
    expect(calls).toHaveLength(1); // only the lookup; no create
    expect(parseBody(calls[0]!).variables).toEqual({ handle: QUALIFYING_COLLECTION_HANDLE });
  });

  it('creates the shared smart collection with the tag NOT_EQUALS rule when none exists', async () => {
    const { fetch, calls } = mockFetch([
      { body: { data: { collectionByIdentifier: null } } },
      {
        body: {
          data: {
            collectionCreate: {
              collection: { id: COLLECTION_GID, handle: QUALIFYING_COLLECTION_HANDLE },
              userErrors: [],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await ensureQualifyingCollection(client);

    expect(result.id).toBe(COLLECTION_GID);
    const input = parseBody(calls[1]!).variables['input'] as {
      handle: string;
      ruleSet: {
        appliedDisjunctively: boolean;
        rules: { column: string; relation: string; condition: string }[];
      };
    };
    expect(input.handle).toBe(QUALIFYING_COLLECTION_HANDLE);
    expect(input.ruleSet.appliedDisjunctively).toBe(false);
    expect(input.ruleSet.rules).toEqual([
      { column: 'TAG', relation: 'NOT_EQUALS', condition: 'app:fge_gift' },
    ]);
  });

  it('throws on collectionCreate userErrors', async () => {
    const { fetch } = mockFetch([
      { body: { data: { collectionByIdentifier: null } } },
      {
        body: {
          data: {
            collectionCreate: { collection: null, userErrors: [{ message: 'Handle taken' }] },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(ensureQualifyingCollection(client)).rejects.toBeInstanceOf(ShopifyUserError);
  });
});

describe('waitForGiftProductsExcluded', () => {
  const P1 = 'gid://shopify/Product/1';
  const P2 = 'gid://shopify/Product/2';
  const noSleep = () => Promise.resolve();

  it('returns true immediately when all gift products are already excluded', async () => {
    const { fetch, calls } = mockFetch([
      { body: { data: { collection: { hasProduct: false } } } },
      { body: { data: { collection: { hasProduct: false } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const ok = await waitForGiftProductsExcluded(client, COLLECTION_GID, [P1, P2], {
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('polls until membership catches up, then returns true', async () => {
    const { fetch } = mockFetch([
      { body: { data: { collection: { hasProduct: true } } } }, // attempt 1: still included
      { body: { data: { collection: { hasProduct: false } } } }, // attempt 2: excluded
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const ok = await waitForGiftProductsExcluded(client, COLLECTION_GID, [P1], { sleep: noSleep });
    expect(ok).toBe(true);
  });

  it('returns false on timeout (caller must not activate the code)', async () => {
    const { fetch } = mockFetch([
      { body: { data: { collection: { hasProduct: true } } } },
      { body: { data: { collection: { hasProduct: true } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const ok = await waitForGiftProductsExcluded(client, COLLECTION_GID, [P1], {
      attempts: 2,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
  });
});

describe('collectionProductCount', () => {
  it('returns the product count for an existing collection', async () => {
    const { fetch } = mockFetch([
      { body: { data: { collection: { id: COLLECTION_GID, productsCount: { count: 16 } } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect(await collectionProductCount(client, COLLECTION_GID)).toBe(16);
  });

  it('returns null when the collection does not exist (provisioning failed)', async () => {
    const { fetch } = mockFetch([{ body: { data: { collection: null } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect(await collectionProductCount(client, COLLECTION_GID)).toBeNull();
  });

  it('returns 0 for an empty collection', async () => {
    const { fetch } = mockFetch([
      { body: { data: { collection: { id: COLLECTION_GID, productsCount: { count: 0 } } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect(await collectionProductCount(client, COLLECTION_GID)).toBe(0);
  });
});
