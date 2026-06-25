import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionTokenError, verifySessionToken } from './sessionToken.js';

const apiKey = 'api-key-123';
const apiSecret = 'app-shared-secret';
const now = new Date('2026-06-15T00:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
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
  iat: nowSeconds - 10,
};

const opts = { apiKey, apiSecret, now };

describe('verifySessionToken', () => {
  it('accepts a valid token and returns its claims', () => {
    const claims = verifySessionToken(sign(validPayload), opts);
    expect(claims.sub).toBe('42');
    expect(claims.aud).toBe(apiKey);
  });

  it('rejects a tampered signature', () => {
    expect(() => verifySessionToken(`${sign(validPayload)}x`, opts)).toThrow(SessionTokenError);
  });

  it('rejects an expired token', () => {
    const token = sign({ ...validPayload, exp: nowSeconds - 60 });
    expect(() => verifySessionToken(token, opts)).toThrow(/expired/i);
  });

  it('rejects a not-yet-valid token', () => {
    const token = sign({ ...validPayload, nbf: nowSeconds + 600 });
    expect(() => verifySessionToken(token, opts)).toThrow(/not yet valid/i);
  });

  it('rejects an audience mismatch', () => {
    const token = sign({ ...validPayload, aud: 'someone-else' });
    expect(() => verifySessionToken(token, opts)).toThrow(/audience/i);
  });

  it('rejects an unsupported algorithm', () => {
    const token = sign(validPayload, { alg: 'none', typ: 'JWT' });
    expect(() => verifySessionToken(token, opts)).toThrow(/alg/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifySessionToken('only.two', opts)).toThrow(SessionTokenError);
  });
});
