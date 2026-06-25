import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAppProxyHmac, verifyOAuthHmac, verifyWebhookHmac } from './hmac.js';

const secret = 'shpss_api_secret';

function signOAuth(params: Record<string, string>): string {
  const message = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHmac('sha256', secret).update(message).digest('hex');
}

describe('verifyOAuthHmac', () => {
  const base = { shop: 'our-store.myshopify.com', code: 'authcode', timestamp: '1700000000' };

  it('accepts a correctly signed query', () => {
    const query = { ...base, hmac: signOAuth(base) };
    expect(verifyOAuthHmac(query, secret)).toBe(true);
  });

  it('rejects a tampered parameter', () => {
    const query = { ...base, hmac: signOAuth(base), shop: 'evil.myshopify.com' };
    expect(verifyOAuthHmac(query, secret)).toBe(false);
  });

  it('rejects a forged hmac', () => {
    expect(verifyOAuthHmac({ ...base, hmac: 'deadbeef' }, secret)).toBe(false);
  });

  it('rejects when hmac is absent', () => {
    expect(verifyOAuthHmac(base, secret)).toBe(false);
  });
});

describe('verifyWebhookHmac', () => {
  const body = JSON.stringify({ id: 123, topic: 'app/uninstalled' });
  const valid = createHmac('sha256', secret).update(body, 'utf8').digest('base64');

  it('accepts a correctly signed body', () => {
    expect(verifyWebhookHmac(body, valid, secret)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyWebhookHmac(body, 'AAAA', secret)).toBe(false);
  });

  it('rejects a modified body', () => {
    expect(verifyWebhookHmac(`${body} `, valid, secret)).toBe(false);
  });
});

describe('verifyAppProxyHmac', () => {
  // App Proxy scheme: sort params (except `signature`), render `key=value`, concatenate with NO
  // separator, hex HMAC-SHA256 with the shared secret.
  function signProxy(params: Record<string, string | readonly string[]>): string {
    const message = Object.keys(params)
      .filter((k) => k !== 'signature')
      .sort()
      .map((k) => {
        const v = params[k];
        return `${k}=${Array.isArray(v) ? v.join(',') : (v as string)}`;
      })
      .join('');
    return createHmac('sha256', secret).update(message).digest('hex');
  }

  const base = {
    shop: 'our-store.myshopify.com',
    path_prefix: '/apps/free-gift',
    timestamp: '1700000000',
    logged_in_customer_id: '',
  };

  it('accepts a correctly signed query', () => {
    expect(verifyAppProxyHmac({ ...base, signature: signProxy(base) }, secret)).toBe(true);
  });

  it('joins multi-value params with a comma', () => {
    const params = { ...base, ids: ['2', '1'] };
    expect(verifyAppProxyHmac({ ...params, signature: signProxy(params) }, secret)).toBe(true);
  });

  it('rejects a tampered parameter', () => {
    const query = { ...base, signature: signProxy(base), shop: 'evil.myshopify.com' };
    expect(verifyAppProxyHmac(query, secret)).toBe(false);
  });

  it('rejects a forged signature', () => {
    expect(verifyAppProxyHmac({ ...base, signature: 'deadbeef' }, secret)).toBe(false);
  });

  it('rejects when signature is absent', () => {
    expect(verifyAppProxyHmac(base, secret)).toBe(false);
  });

  it('rejects a multi-valued signature', () => {
    expect(verifyAppProxyHmac({ ...base, signature: ['a', 'b'] }, secret)).toBe(false);
  });
});
