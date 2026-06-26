import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionTokenError } from '../security/sessionToken.js';
import { shopFromBearer } from './session.js';

const apiKey = 'api-key-123';
const apiSecret = 'app-shared-secret';
const now = new Date('2026-06-15T00:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

function sign(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const validPayload = {
  iss: 'https://our-store.myshopify.com/admin',
  dest: 'https://our-store.myshopify.com',
  aud: apiKey,
  sub: '42',
  exp: nowSeconds + 60,
  nbf: nowSeconds - 10,
};
const config = { apiKey, apiSecret, now };

describe('shopFromBearer', () => {
  it('returns the verified shop from a valid Bearer session token', () => {
    expect(shopFromBearer(`Bearer ${sign(validPayload)}`, config)).toBe('our-store.myshopify.com');
  });

  it('rejects a missing / non-Bearer header', () => {
    expect(() => shopFromBearer(null, config)).toThrow(SessionTokenError);
    expect(() => shopFromBearer(sign(validPayload), config)).toThrow(SessionTokenError); // no "Bearer "
  });

  it('rejects a tampered token (propagates the JWT verification failure)', () => {
    expect(() => shopFromBearer(`Bearer ${sign(validPayload)}x`, config)).toThrow(
      SessionTokenError,
    );
  });

  it('rejects a token whose dest is not a valid shop domain', () => {
    const token = sign({ ...validPayload, dest: 'https://evil.example.com' });
    expect(() => shopFromBearer(`Bearer ${token}`, config)).toThrow(SessionTokenError);
  });
});
