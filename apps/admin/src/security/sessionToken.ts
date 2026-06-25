import { createHmac, timingSafeEqual } from 'node:crypto';

// App Bridge session tokens are HS256 JWTs signed with the app's API secret. We verify them on
// every embedded API request without a JWT library: validate the header alg, recompute the
// signature constant-time, then check the standard time claims. `now` is injected for testing.

export type SessionTokenClaims = {
  readonly iss: string;
  readonly dest: string;
  readonly aud: string;
  readonly sub: string;
  readonly exp: number;
  readonly nbf: number;
  readonly iat: number;
};

export class SessionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTokenError';
  }
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export type VerifyOptions = {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly now?: Date;
  // Allowable clock skew in seconds for exp/nbf. Defaults to 5.
  readonly leewaySeconds?: number;
};

export function verifySessionToken(token: string, options: VerifyOptions): SessionTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new SessionTokenError('Malformed token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64!).toString('utf8')) as {
    alg?: string;
    typ?: string;
  };
  if (header.alg !== 'HS256') {
    throw new SessionTokenError(`Unsupported alg: ${String(header.alg)}`);
  }

  const expected = createHmac('sha256', options.apiSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  if (!safeEqual(expected, base64UrlDecode(signatureB64!))) {
    throw new SessionTokenError('Invalid signature');
  }

  const claims = JSON.parse(base64UrlDecode(payloadB64!).toString('utf8')) as SessionTokenClaims;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const leeway = options.leewaySeconds ?? 5;
  if (typeof claims.exp !== 'number' || nowSeconds >= claims.exp + leeway) {
    throw new SessionTokenError('Token expired');
  }
  if (typeof claims.nbf !== 'number' || nowSeconds < claims.nbf - leeway) {
    throw new SessionTokenError('Token not yet valid');
  }
  if (claims.aud !== options.apiKey) {
    throw new SessionTokenError('Audience mismatch');
  }
  return claims;
}
