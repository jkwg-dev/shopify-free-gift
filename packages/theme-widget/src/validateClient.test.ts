import { money, type ValidateRequest } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_PATH, postValidate } from './validateClient.js';

const request: ValidateRequest = {
  cart: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1, appAdded: false }],
  choices: { t1: 'a' },
  declined: false,
  presentmentCurrency: 'CAD',
  countryCode: 'CA',
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  // Minimal Response-like stub; only the bits postValidate reads.
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })) as unknown as typeof fetch;
}

describe('postValidate', () => {
  it('parses a gift result on 200', async () => {
    const giftBody = {
      status: 'gift',
      currency: 'CAD',
      subtotal: money(60000, 'CAD'),
      tierId: 't1',
      giftVariantIds: ['gid://shopify/ProductVariant/ICE'],
      code: 'CODE-1',
      appliedThreshold: money(50000, 'CAD'),
    };
    const res = await postValidate(request, { fetchFn: fakeFetch(200, giftBody) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.status).toBe('gift');
    if (res.result.status !== 'gift') return;
    expect(res.result.code).toBe('CODE-1');
  });

  it('parses a no-gift result on 200', async () => {
    const res = await postValidate(request, {
      fetchFn: fakeFetch(200, { status: 'no-gift', reason: 'below-threshold' }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.status !== 'no-gift') return;
    expect(res.result.reason).toBe('below-threshold');
  });

  it('returns the error envelope on a non-2xx response', async () => {
    const res = await postValidate(request, {
      fetchFn: fakeFetch(401, { error: { code: 'UNAUTHORIZED', message: 'bad sig' } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(401);
    expect(res.error.code).toBe('UNAUTHORIZED');
  });

  it('posts JSON to the default App Proxy path', async () => {
    let calledPath = '';
    const captureFetch = ((path: string) => {
      calledPath = path;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'no-gift', reason: 'inactive' }),
      });
    }) as unknown as typeof fetch;
    await postValidate(request, { fetchFn: captureFetch });
    expect(calledPath).toBe(DEFAULT_PROXY_PATH);
  });
});
