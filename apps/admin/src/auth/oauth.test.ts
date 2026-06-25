import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken } from '../security/crypto.js';
import { FakeShopRepository, FakeTokenExchanger } from '../testing/fakes.js';
import { buildAuthorizeUrl, handleOAuthCallback, OAuthError } from './oauth.js';

const apiSecret = 'shpss_secret';
const encryptionKey = randomBytes(32).toString('base64');

function withHmac(params: Record<string, string>): Record<string, string> {
  const message = Object.keys(params)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return { ...params, hmac: createHmac('sha256', apiSecret).update(message).digest('hex') };
}

const callbackDeps = () => ({
  apiSecret,
  encryptionKey,
  exchanger: new FakeTokenExchanger('shpat_token', 'read_products'),
  shopRepo: new FakeShopRepository(),
});

describe('buildAuthorizeUrl', () => {
  it('builds the authorize URL with the offline grant params', () => {
    const url = buildAuthorizeUrl({
      shop: 'our-store.myshopify.com',
      apiKey: 'key',
      scopes: 'read_products,write_discounts',
      redirectUri: 'https://app.example.com/auth/callback',
      state: 'nonce',
    });
    expect(url).toContain('https://our-store.myshopify.com/admin/oauth/authorize?');
    expect(url).toContain('client_id=key');
    expect(url).toContain('state=nonce');
  });

  it('rejects a non-myshopify domain', () => {
    expect(() =>
      buildAuthorizeUrl({
        shop: 'evil.com',
        apiKey: 'key',
        scopes: 's',
        redirectUri: 'https://x',
        state: 'n',
      }),
    ).toThrow(OAuthError);
  });
});

describe('handleOAuthCallback', () => {
  it('verifies HMAC, exchanges the code, and stores the token encrypted', async () => {
    const deps = callbackDeps();
    const query = withHmac({
      shop: 'our-store.myshopify.com',
      code: 'authcode',
      timestamp: '1700000000',
    });

    const shop = await handleOAuthCallback(query, deps);

    expect(shop.domain).toBe('our-store.myshopify.com');
    const stored = deps.shopRepo.upserts[0]?.encryptedAccessToken;
    expect(stored).toBeDefined();
    expect(stored).not.toContain('shpat_token');
    expect(decryptToken(stored!, encryptionKey)).toBe('shpat_token');
  });

  it('rejects an invalid HMAC before exchanging anything', async () => {
    const deps = callbackDeps();
    const query = { shop: 'our-store.myshopify.com', code: 'authcode', hmac: 'forged' };
    await expect(handleOAuthCallback(query, deps)).rejects.toBeInstanceOf(OAuthError);
    expect(deps.shopRepo.upserts).toHaveLength(0);
  });

  it('rejects a non-myshopify shop even with a valid signature', async () => {
    const deps = callbackDeps();
    const query = withHmac({ shop: 'evil.com', code: 'authcode' });
    await expect(handleOAuthCallback(query, deps)).rejects.toBeInstanceOf(OAuthError);
  });
});
