import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { fetchGiftChannelAvailability } from './channelAvailability.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const PUB = 'gid://shopify/Publication/157545496685';

function node(id: string, availableForSale: boolean, published: boolean) {
  return {
    __typename: 'ProductVariant',
    id,
    availableForSale,
    product: { publishedOnPublication: published },
  };
}

describe('fetchGiftChannelAvailability', () => {
  it('returns stock + publish per variant and passes the publication id', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              node('gid://shopify/ProductVariant/1', true, true),
              node('gid://shopify/ProductVariant/2', false, true), // out of stock
              node('gid://shopify/ProductVariant/3', true, false), // unpublished
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(
      client,
      [
        'gid://shopify/ProductVariant/1',
        'gid://shopify/ProductVariant/2',
        'gid://shopify/ProductVariant/3',
      ],
      PUB,
    );

    expect(map.get('gid://shopify/ProductVariant/1')).toEqual({
      availableForSale: true,
      publishedToOnlineStore: true,
    });
    expect(map.get('gid://shopify/ProductVariant/2')).toEqual({
      availableForSale: false,
      publishedToOnlineStore: true,
    });
    expect(map.get('gid://shopify/ProductVariant/3')).toEqual({
      availableForSale: true,
      publishedToOnlineStore: false,
    });
    expect(parseBody(calls[0]!).variables).toEqual({
      ids: [
        'gid://shopify/ProductVariant/1',
        'gid://shopify/ProductVariant/2',
        'gid://shopify/ProductVariant/3',
      ],
      publicationId: PUB,
    });
  });

  it('omits unresolved ids and non-variant nodes (missing entry == unavailable to the caller)', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              node('gid://shopify/ProductVariant/1', true, true),
              null,
              { __typename: 'Product' },
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(
      client,
      ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/missing', 'gid://x'],
      PUB,
    );

    expect([...map.keys()]).toEqual(['gid://shopify/ProductVariant/1']);
  });

  it('skips a variant whose product is null (partial error) instead of dereferencing it', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              node('gid://shopify/ProductVariant/1', true, true),
              {
                __typename: 'ProductVariant',
                id: 'gid://shopify/ProductVariant/2',
                availableForSale: true,
                product: null,
              },
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(
      client,
      ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
      PUB,
    );

    expect([...map.keys()]).toEqual(['gid://shopify/ProductVariant/1']);
  });

  it('tolerates a partial GraphQL error: one errored node omitted, the rest resolve (no throw)', async () => {
    // The real repro shape: a field error on one node nulls THAT node and adds an errors[] entry with
    // its path; the batch must NOT throw (which would grey every gift) — only the bad gift is omitted.
    const { fetch } = mockFetch([
      {
        body: {
          data: { nodes: [node('gid://shopify/ProductVariant/1', true, true), null] },
          errors: [
            {
              message: 'Access denied for publishedOnPublication',
              path: ['nodes', 1, 'product', 'publishedOnPublication'],
            },
          ],
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(
      client,
      ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
      PUB,
    );

    // Only the surviving variant is present; the errored one is omitted (caller greys exactly it).
    expect([...map.keys()]).toEqual(['gid://shopify/ProductVariant/1']);
    expect(map.get('gid://shopify/ProductVariant/1')).toEqual({
      availableForSale: true,
      publishedToOnlineStore: true,
    });
  });

  it('batches ids in chunks of 250', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: ids.slice(0, 250).map((id) => node(id, true, true)) } } },
      { body: { data: { nodes: ids.slice(250).map((id) => node(id, true, true)) } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(client, ids, PUB);

    expect(calls).toHaveLength(2);
    expect(map.size).toBe(251);
  });

  it('returns an empty map for an empty id list without calling Shopify', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect((await fetchGiftChannelAvailability(client, [], PUB)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
