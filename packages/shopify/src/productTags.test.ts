import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { ShopifyUserError } from './errors.js';
import { tagGiftProducts, untagGiftProducts } from './productTags.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const V1 = 'gid://shopify/ProductVariant/1';
const V2 = 'gid://shopify/ProductVariant/2';
const PRODUCT = 'gid://shopify/Product/100';

function variantNode(id: string, productId: string) {
  return { __typename: 'ProductVariant', id, product: { id: productId } };
}

describe('tagGiftProducts', () => {
  it('resolves variants to their product and tags it once (dedup; idempotent tag)', async () => {
    // Two sibling variants of ONE product -> a single tagsAdd on that product.
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: [variantNode(V1, PRODUCT), variantNode(V2, PRODUCT)] } } },
      { body: { data: { tagsAdd: { userErrors: [] } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const tagged = await tagGiftProducts(client, [V1, V2]);

    expect(tagged).toEqual([PRODUCT]);
    expect(calls).toHaveLength(2); // 1 resolve + 1 tagsAdd
    expect(parseBody(calls[1]!).variables).toEqual({ id: PRODUCT, tags: ['_fge_gift'] });
  });

  it('tags each distinct product owning the gift variants', async () => {
    const P2 = 'gid://shopify/Product/200';
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: [variantNode(V1, PRODUCT), variantNode(V2, P2)] } } },
      { body: { data: { tagsAdd: { userErrors: [] } } } },
      { body: { data: { tagsAdd: { userErrors: [] } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const tagged = await tagGiftProducts(client, [V1, V2]);

    expect(tagged).toEqual([PRODUCT, P2]);
    expect(calls).toHaveLength(3);
  });

  it('throws on tagsAdd userErrors', async () => {
    const { fetch } = mockFetch([
      { body: { data: { nodes: [variantNode(V1, PRODUCT)] } } },
      { body: { data: { tagsAdd: { userErrors: [{ message: 'nope' }] } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(tagGiftProducts(client, [V1])).rejects.toBeInstanceOf(ShopifyUserError);
  });

  it('no-ops on empty variant list (no Shopify call)', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    expect(await tagGiftProducts(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('untagGiftProducts', () => {
  it('resolves and removes the tag from the owning product', async () => {
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: [variantNode(V1, PRODUCT)] } } },
      { body: { data: { tagsRemove: { userErrors: [] } } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const untagged = await untagGiftProducts(client, [V1]);

    expect(untagged).toEqual([PRODUCT]);
    expect(parseBody(calls[1]!).variables).toEqual({ id: PRODUCT, tags: ['_fge_gift'] });
  });
});
