import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { GiftVariantValidationError } from './errors.js';
import { fetchGiftVariants } from './products.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const variantNode = (id: string) => ({
  __typename: 'ProductVariant',
  id,
  title: 'Default',
  availableForSale: true,
  price: '0.00',
  product: { id: `gid://shopify/Product/${id}`, title: 'Gift', status: 'ACTIVE' },
});

describe('fetchGiftVariants', () => {
  it('returns [] for no ids without calling the API', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(fetchGiftVariants(client, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fetches variants in a single batched call (no N+1)', async () => {
    const ids = ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'];
    const { fetch, calls } = mockFetch([{ body: { data: { nodes: ids.map(variantNode) } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await fetchGiftVariants(client, ids);

    expect(calls).toHaveLength(1);
    expect(parseBody(calls[0]!).variables).toEqual({ ids });
    expect(result.map((v) => v.id)).toEqual(ids);
  });

  it('preserves caller order even if the API returns them shuffled', async () => {
    const ids = ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'];
    const { fetch } = mockFetch([
      { body: { data: { nodes: [variantNode(ids[1]!), variantNode(ids[0]!)] } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await fetchGiftVariants(client, ids);
    expect(result.map((v) => v.id)).toEqual(ids);
  });

  it('throws GiftVariantValidationError when an id is missing (null node)', async () => {
    const ids = ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/missing'];
    const { fetch } = mockFetch([{ body: { data: { nodes: [variantNode(ids[0]!), null] } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(fetchGiftVariants(client, ids)).rejects.toBeInstanceOf(GiftVariantValidationError);
  });

  it('throws when an id resolves to a non-variant type', async () => {
    const ids = ['gid://shopify/Product/1'];
    const { fetch } = mockFetch([{ body: { data: { nodes: [{ __typename: 'Product' }] } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(fetchGiftVariants(client, ids)).rejects.toBeInstanceOf(GiftVariantValidationError);
  });

  it('batches more than 250 ids into multiple calls', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: ids.slice(0, 250).map(variantNode) } } },
      { body: { data: { nodes: ids.slice(250).map(variantNode) } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await fetchGiftVariants(client, ids);

    expect(calls).toHaveLength(2);
    expect((parseBody(calls[0]!).variables.ids as string[]).length).toBe(250);
    expect((parseBody(calls[1]!).variables.ids as string[]).length).toBe(50);
    expect(result).toHaveLength(300);
  });
});
