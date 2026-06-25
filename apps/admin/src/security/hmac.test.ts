import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOAuthHmac, verifyWebhookHmac } from './hmac.js';

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
