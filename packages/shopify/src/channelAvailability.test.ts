import { describe, expect, it, vi } from 'vitest';
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

  it('tolerates a GENERIC partial error (not a scope gap): one node omitted, the rest resolve', async () => {
    // A non-scope per-node error (e.g. a transient internal error) nulls THAT node and adds an errors[]
    // entry; the batch must NOT throw (which would grey every gift) — only the bad gift is omitted. The
    // message is deliberately NOT an access-denied one, so it is the per-node path, not the scope fallback.
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: { nodes: [node('gid://shopify/ProductVariant/1', true, true), null] },
          errors: [
            {
              message: 'Internal error resolving node',
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
    expect(calls).toHaveLength(1); // generic per-node error -> NO stock-only fallback
  });

  it('falls back to STOCK-ONLY (no grey-all) when read_publications is missing (ACCESS_DENIED)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = mockFetch([
      // Combined query: the token lacks read_publications -> every publishedOnPublication is denied,
      // which nulls every node (the error propagates to the nullable list element) + an ACCESS_DENIED
      // errors[] entry carrying the publishedOnPublication path.
      {
        body: {
          data: { nodes: [null, null] },
          errors: [
            {
              message:
                'Access denied for publishedOnPublication field. Required access: read_publications access scope.',
              path: ['nodes', 0, 'product', 'publishedOnPublication'],
              extensions: { code: 'ACCESS_DENIED' },
            },
          ],
        },
      },
      // Stock-only re-query (read_products): availableForSale resolves for both variants.
      {
        body: {
          data: {
            nodes: [
              {
                __typename: 'ProductVariant',
                id: 'gid://shopify/ProductVariant/1',
                availableForSale: true,
              },
              {
                __typename: 'ProductVariant',
                id: 'gid://shopify/ProductVariant/2',
                availableForSale: false,
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

    // NOT grey-all: both variants present, stock from the fallback, publication forced true (not gating).
    expect(map.get('gid://shopify/ProductVariant/1')).toEqual({
      availableForSale: true,
      publishedToOnlineStore: true,
    });
    expect(map.get('gid://shopify/ProductVariant/2')).toEqual({
      availableForSale: false,
      publishedToOnlineStore: true,
    });
    expect(calls).toHaveLength(2); // combined (denied) + stock-only fallback
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read_publications missing'));
    warn.mockRestore();
  });

  it('treats publishedOnPublication=false as a REAL signal (greys that gift), not a scope gap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: [node('gid://shopify/ProductVariant/1', true, false)] } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const map = await fetchGiftChannelAvailability(client, ['gid://shopify/ProductVariant/1'], PUB);

    // The false is returned (caller greys exactly this gift) — NOT conflated with a scope gap.
    expect(map.get('gid://shopify/ProductVariant/1')).toEqual({
      availableForSale: true,
      publishedToOnlineStore: false,
    });
    expect(calls).toHaveLength(1); // no stock-only fallback
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
