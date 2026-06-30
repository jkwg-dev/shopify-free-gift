import { createHmac } from 'node:crypto';
import { money } from '@free-gift-engine/core';
import type { VariantPricing } from '@free-gift-engine/shopify';
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../domain.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import { FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import { handleValidate, type ValidateHandlerDeps, type ValidateHttpRequest } from './handler.js';

const SECRET = 'shpss_secret';
const P1 = 'gid://shopify/ProductVariant/P1';
const G1 = 'gid://shopify/ProductVariant/G1';
const G2 = 'gid://shopify/ProductVariant/G2';
const NOW = new Date('2026-06-25T12:00:00Z');

function priceVariants(variantIds: readonly string[]): Promise<VariantPricing[]> {
  const table: Record<string, string> = { [P1]: '60.00', [G1]: '20.00', [G2]: '30.00' };
  return Promise.resolve(
    variantIds.flatMap((id) =>
      table[id] === undefined
        ? []
        : [
            {
              id,
              productId: `gid://shopify/Product/${id.split('/').pop()}`,
              availableForSale: true,
              price: { amount: table[id]!, currencyCode: 'USD' },
            },
          ],
    ),
  );
}

function andCampaign(): Campaign {
  return {
    id: 'camp1',
    shopId: 'shop1',
    name: 'Summer',
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-07-01T00:00:00Z'),
    displayTimezone: 'UTC',
    active: true,
    configVersionHash: 'cfg-1',
    qualifyingCollectionId: 'gid://shopify/Collection/q',
    tiers: [
      {
        id: 't1',
        campaignId: 'camp1',
        position: 1,
        baseThreshold: money(5000, 'USD'),
        gift: { kind: 'AND', gifts: [{ variantId: G1 }] },
        marketThresholds: [],
      },
    ],
  };
}

function orCampaign(): Campaign {
  const c = andCampaign();
  return {
    ...c,
    tiers: [
      {
        ...c.tiers[0]!,
        gift: {
          kind: 'OR',
          options: [
            { id: 'a', variantId: G1 },
            { id: 'b', variantId: G2 },
          ],
        },
      },
    ],
  };
}

function makeDeps(
  overrides: Partial<ValidateHandlerDeps> = {},
  useRealSignature = false,
): ValidateHandlerDeps {
  const gateway = new FakeDiscountGateway();
  return {
    apiSecret: SECRET,
    rateLimiter: { take: () => Promise.resolve(true) },
    resolveActiveCampaign: () =>
      Promise.resolve({ shopId: 'shop1', baseCurrency: 'USD', campaign: andCampaign() }),
    priceVariants,
    fetchChannelAvailability: (ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { availableForSale: true, publishedToOnlineStore: true }])),
      ),
    mappingStore: new GiftCodeMappingStore(new FakeMappingTable(), gateway),
    fetchCollectionMembership: (_collectionId, productIds) => Promise.resolve(new Set(productIds)),
    now: () => NOW,
    // The real handler falls back to verifyAppProxyHmac when this is absent.
    ...(useRealSignature ? {} : { verifySignature: () => true }),
    ...overrides,
  };
}

const VALID_BODY = JSON.stringify({
  cart: [{ variantId: P1, quantity: 1, appAdded: false }],
  choices: {},
  declined: false,
  presentmentCurrency: 'USD',
  countryCode: 'US',
});

function httpReq(overrides: Partial<ValidateHttpRequest> = {}): ValidateHttpRequest {
  return {
    method: 'POST',
    query: { shop: 'shop.myshopify.com' },
    headers: {},
    rawBody: VALID_BODY,
    ...overrides,
  };
}

describe('handleValidate', () => {
  it('returns 200 and a gift result for a valid request', async () => {
    const res = await handleValidate(httpReq(), makeDeps());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'gift' });
  });

  it('returns 401 for an invalid signature', async () => {
    const res = await handleValidate(httpReq(), makeDeps({ verifySignature: () => false }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('returns 401 when shop is missing', async () => {
    const res = await handleValidate(httpReq({ query: {} }), makeDeps());
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    const res = await handleValidate(
      httpReq(),
      makeDeps({ rateLimiter: { take: () => Promise.resolve(false) } }),
    );
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('derives the rate-limit key from the trusted shop + customer identity', async () => {
    const keys: string[] = [];
    const rateLimiter = {
      take: (key: string) => {
        keys.push(key);
        return Promise.resolve(true);
      },
    };
    await handleValidate(
      httpReq({ query: { shop: 'shop.myshopify.com', logged_in_customer_id: '42' } }),
      makeDeps({ rateLimiter }),
    );
    expect(keys).toEqual(['shop.myshopify.com:42']);
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await handleValidate(httpReq({ rawBody: 'not json' }), makeDeps());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('returns 400 for a malformed cart line', async () => {
    const body = JSON.stringify({
      cart: [{ variantId: P1, quantity: -1, appAdded: false }],
      choices: {},
      declined: false,
      presentmentCurrency: 'USD',
      countryCode: 'US',
    });
    const res = await handleValidate(httpReq({ rawBody: body }), makeDeps());
    expect(res.status).toBe(400);
  });

  it('returns 405 for a non-POST method', async () => {
    const res = await handleValidate(httpReq({ method: 'GET' }), makeDeps());
    expect(res.status).toBe(405);
  });

  it('accepts an optional valid presentmentRate (base-currency request still 200)', async () => {
    const body = JSON.stringify({
      cart: [{ variantId: P1, quantity: 1, appAdded: false }],
      choices: {},
      declined: false,
      presentmentCurrency: 'USD',
      countryCode: 'US',
      presentmentRate: '0.71866446',
    });
    const res = await handleValidate(httpReq({ rawBody: body }), makeDeps());
    expect(res.status).toBe(200);
  });

  it('returns 400 for a present-but-invalid presentmentRate', async () => {
    const base = {
      cart: [{ variantId: P1, quantity: 1, appAdded: false }],
      choices: {},
      declined: false,
      presentmentCurrency: 'USD',
      countryCode: 'US',
    };
    for (const bad of ['0', '-1', 'abc', '']) {
      const res = await handleValidate(
        httpReq({ rawBody: JSON.stringify({ ...base, presentmentRate: bad }) }),
        makeDeps(),
      );
      expect(res.status, `rate=${bad}`).toBe(400);
    }
    // non-string is also rejected
    const nonString = await handleValidate(
      httpReq({ rawBody: JSON.stringify({ ...base, presentmentRate: 1.5 }) }),
      makeDeps(),
    );
    expect(nonString.status).toBe(400);
  });

  it('maps an invalid OR choice to 400', async () => {
    const deps = makeDeps({
      resolveActiveCampaign: () =>
        Promise.resolve({ shopId: 'shop1', baseCurrency: 'USD', campaign: orCampaign() }),
    });
    const res = await handleValidate(httpReq(), deps); // choices: {} -> invalid for OR tier
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  describe('real App Proxy signature', () => {
    function sign(query: Record<string, string>): string {
      const message = Object.keys(query)
        .filter((k) => k !== 'signature')
        .sort()
        .map((k) => `${k}=${query[k]}`)
        .join('');
      return createHmac('sha256', SECRET).update(message).digest('hex');
    }

    const params = {
      shop: 'shop.myshopify.com',
      path_prefix: '/apps/free-gift',
      timestamp: '1700000000',
    };

    it('accepts a genuinely signed request (real verifier)', async () => {
      const query = { ...params, signature: sign(params) };
      const res = await handleValidate(httpReq({ query }), makeDeps({}, true));
      expect(res.status).toBe(200);
    });

    it('rejects a tampered request', async () => {
      const query = { ...params, signature: sign(params), shop: 'evil.myshopify.com' };
      const res = await handleValidate(httpReq({ query }), makeDeps({}, true));
      expect(res.status).toBe(401);
    });
  });
});
