import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { fetchVariantPricing } from './pricing.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

function node(id: string, amount: string, currencyCode: string, availableForSale = true) {
  return {
    __typename: 'ProductVariant',
    id,
    availableForSale,
    contextualPricing: { price: { amount, currencyCode } },
  };
}

describe('fetchVariantPricing', () => {
  it('returns presentment price + availability and passes the country context', async () => {
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: [node('gid://shopify/ProductVariant/1', '12.99', 'CAD')] } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const priced = await fetchVariantPricing(client, ['gid://shopify/ProductVariant/1'], {
      country: 'CA',
    });

    expect(priced).toEqual([
      {
        id: 'gid://shopify/ProductVariant/1',
        availableForSale: true,
        price: { amount: '12.99', currencyCode: 'CAD' },
      },
    ]);
    expect(parseBody(calls[0]!).variables).toEqual({
      ids: ['gid://shopify/ProductVariant/1'],
      country: 'CA',
    });
  });

  it('skips unresolved ids and non-variant nodes instead of throwing (cart may hold a deleted variant)', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              node('gid://shopify/ProductVariant/1', '10.00', 'USD'),
              null,
              { __typename: 'Product' },
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const priced = await fetchVariantPricing(
      client,
      ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/missing', 'gid://x'],
      { country: 'US' },
    );

    expect(priced.map((p) => p.id)).toEqual(['gid://shopify/ProductVariant/1']);
  });

  it('treats a variant with null contextualPricing as unpriceable (skipped)', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            nodes: [
              {
                __typename: 'ProductVariant',
                id: 'gid://v/1',
                availableForSale: true,
                contextualPricing: null,
              },
            ],
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect(await fetchVariantPricing(client, ['gid://v/1'], { country: 'US' })).toEqual([]);
  });

  it('batches ids in chunks of 250', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
    const { fetch, calls } = mockFetch([
      { body: { data: { nodes: ids.slice(0, 250).map((id) => node(id, '1.00', 'USD')) } } },
      { body: { data: { nodes: ids.slice(250).map((id) => node(id, '1.00', 'USD')) } } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const priced = await fetchVariantPricing(client, ids, { country: 'US' });

    expect(calls).toHaveLength(2);
    expect(priced).toHaveLength(251);
  });

  it('returns nothing for an empty id list without calling Shopify', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    expect(await fetchVariantPricing(client, [], { country: 'US' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
