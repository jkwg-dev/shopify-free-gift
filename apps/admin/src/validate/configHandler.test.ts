import { createHmac } from 'node:crypto';
import type { CampaignConfigResponse } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { type ConfigHandlerDeps, type ConfigHttpRequest, handleConfig } from './configHandler.js';

const SECRET = 'shpss_secret';

const ACTIVE: CampaignConfigResponse = {
  status: 'active',
  currency: 'USD',
  declineEnabled: true,
  tiers: [],
};

function makeDeps(
  overrides: Partial<ConfigHandlerDeps> = {},
  useRealSignature = false,
): ConfigHandlerDeps {
  return {
    apiSecret: SECRET,
    rateLimiter: { take: () => Promise.resolve(true) },
    resolveActiveCampaign: () =>
      Promise.resolve({
        shopId: 'shop1',
        baseCurrency: 'USD',
        // resolveCampaignConfig builds from the campaign; an empty-tier campaign yields {tiers: []}.
        campaign: {
          id: 'c1',
          shopId: 'shop1',
          name: 'S',
          suppression: 'highest-only',
          declineEnabled: true,
          startsAt: new Date('2026-06-01T00:00:00Z'),
          endsAt: new Date('2026-07-01T00:00:00Z'),
          displayTimezone: 'UTC',
          active: true,
          configVersionHash: 'cfg-1',
          tiers: [],
        },
      }),
    priceVariants: () => Promise.resolve([]),
    fetchVariantMeta: () => Promise.resolve([]),
    ...(useRealSignature ? {} : { verifySignature: () => true }),
    ...overrides,
  };
}

// Reproduce Shopify's App Proxy signature over a GET query: every param except `signature`, sorted,
// rendered key=value, concatenated with NO separator, hex HMAC-SHA256 keyed by the shared secret.
function sign(query: Record<string, string>): string {
  const message = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('');
  return createHmac('sha256', SECRET).update(message).digest('hex');
}

function httpReq(overrides: Partial<ConfigHttpRequest> = {}): ConfigHttpRequest {
  return {
    method: 'GET',
    query: { shop: 'shop.myshopify.com', currency: 'USD', country: 'US' },
    headers: {},
    ...overrides,
  };
}

describe('handleConfig', () => {
  it('returns 200 and the active config for a valid request', async () => {
    const res = await handleConfig(httpReq(), makeDeps());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ACTIVE);
  });

  it('rejects a non-GET method with 405', async () => {
    const res = await handleConfig(httpReq({ method: 'POST' }), makeDeps());
    expect(res.status).toBe(405);
  });

  it('returns 401 for an invalid signature', async () => {
    const res = await handleConfig(httpReq(), makeDeps({ verifySignature: () => false }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when shop is missing', async () => {
    const res = await handleConfig(
      httpReq({ query: { currency: 'USD', country: 'US' } }),
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    const res = await handleConfig(
      httpReq(),
      makeDeps({ rateLimiter: { take: () => Promise.resolve(false) } }),
    );
    expect(res.status).toBe(429);
  });

  it('requires currency and country', async () => {
    const noCurrency = await handleConfig(
      httpReq({ query: { shop: 's.myshopify.com', country: 'US' } }),
      makeDeps(),
    );
    expect(noCurrency.status).toBe(400);
    const noCountry = await handleConfig(
      httpReq({ query: { shop: 's.myshopify.com', currency: 'USD' } }),
      makeDeps(),
    );
    expect(noCountry.status).toBe(400);
  });

  // The GET/query auth path: country + currency are part of the SIGNED input (not trusted unsigned).
  it('verifies the real App Proxy HMAC over the GET query (incl. country/currency)', async () => {
    const query: Record<string, string> = {
      shop: 'shop.myshopify.com',
      currency: 'USD',
      country: 'US',
    };
    query['signature'] = sign(query);

    const ok = await handleConfig(httpReq({ query }), makeDeps({}, true));
    expect(ok.status).toBe(200);

    // Tampering with a signed param (country) must invalidate the signature -> 401.
    const tampered = await handleConfig(
      httpReq({ query: { ...query, country: 'CA' } }),
      makeDeps({}, true),
    );
    expect(tampered.status).toBe(401);
  });
});
