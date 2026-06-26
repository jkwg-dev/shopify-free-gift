import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { fetchVariantMeta } from './variantMeta.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const V1 = 'gid://shopify/ProductVariant/1';
const V2 = 'gid://shopify/ProductVariant/2';

function variantNode(
  id: string,
  title: string,
  productId: string,
  productTitle: string,
  imageUrl: string | null = null,
) {
  return {
    __typename: 'ProductVariant',
    id,
    title,
    image: imageUrl === null ? null : { url: imageUrl },
    product: { id: productId, title: productTitle, featuredImage: null },
  };
}

describe('fetchVariantMeta', () => {
  it('resolves variants to product id + titles', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              variantNode(
                V1,
                'Ice',
                'gid://shopify/Product/100',
                'The Complete Snowboard',
                'https://cdn/ice.jpg',
              ),
              variantNode(V2, 'Dawn', 'gid://shopify/Product/100', 'The Complete Snowboard'),
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const meta = await fetchVariantMeta(client, [V1, V2]);

    expect(meta).toEqual([
      {
        id: V1,
        productId: 'gid://shopify/Product/100',
        productTitle: 'The Complete Snowboard',
        variantTitle: 'Ice',
        imageUrl: 'https://cdn/ice.jpg', // variant image preferred
      },
      {
        id: V2,
        productId: 'gid://shopify/Product/100',
        productTitle: 'The Complete Snowboard',
        variantTitle: 'Dawn',
        imageUrl: null, // no variant or product image
      },
    ]);
    expect(parseBody(calls[0]!).variables).toEqual({ ids: [V1, V2] });
  });

  it('omits a node that no longer resolves to a variant (deleted)', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [variantNode(V1, 'Ice', 'gid://shopify/Product/100', 'Complete'), null],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const meta = await fetchVariantMeta(client, [V1, V2]);
    expect(meta).toHaveLength(1);
    expect(meta[0]!.id).toBe(V1);
  });

  it('falls back to the product featured image when the variant has none', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              {
                __typename: 'ProductVariant',
                id: V1,
                title: 'Default Title',
                image: null,
                product: {
                  id: 'gid://shopify/Product/100',
                  title: 'The Hidden Snowboard',
                  featuredImage: { url: 'https://cdn/hidden.jpg' },
                },
              },
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    const meta = await fetchVariantMeta(client, [V1]);
    expect(meta[0]!.imageUrl).toBe('https://cdn/hidden.jpg');
  });

  it('no-ops on empty input (no Shopify call)', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    expect(await fetchVariantMeta(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
