import { describe, expect, it } from 'vitest';
import { ShopifyHttpError } from './errors.js';
import { exchangeAccessToken } from './oauth.js';
import { mockFetch } from './test-helpers.js';

const input = {
  shop: 'our-store.myshopify.com',
  code: 'authcode',
  apiKey: 'client-id',
  apiSecret: 'client-secret',
};

describe('exchangeAccessToken', () => {
  it('exchanges the code and returns the offline token + scopes', async () => {
    const { fetch, calls } = mockFetch([
      { body: { access_token: 'shpat_offline', scope: 'read_products,write_discounts' } },
    ]);

    const result = await exchangeAccessToken(fetch, input);

    expect(result).toEqual({
      accessToken: 'shpat_offline',
      scopes: 'read_products,write_discounts',
    });
    expect(calls[0]!.url).toBe('https://our-store.myshopify.com/admin/oauth/access_token');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'authcode',
    });
  });

  it('defaults scopes to empty string when absent', async () => {
    const { fetch } = mockFetch([{ body: { access_token: 'shpat_offline' } }]);
    expect(await exchangeAccessToken(fetch, input)).toEqual({
      accessToken: 'shpat_offline',
      scopes: '',
    });
  });

  it('throws ShopifyHttpError on a non-2xx response', async () => {
    const { fetch } = mockFetch([{ ok: false, status: 401, text: 'invalid_request' }]);
    await expect(exchangeAccessToken(fetch, input)).rejects.toBeInstanceOf(ShopifyHttpError);
  });

  it('throws when the response carries no access_token', async () => {
    const { fetch } = mockFetch([{ body: { scope: 'read_products' } }]);
    await expect(exchangeAccessToken(fetch, input)).rejects.toBeInstanceOf(ShopifyHttpError);
  });
});
