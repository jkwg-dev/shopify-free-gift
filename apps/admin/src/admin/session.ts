// Embedded-admin request auth: turn an `Authorization: Bearer <session-token>` header into a verified
// shop domain. Wraps verifySessionToken (the HS256 App Bridge JWT check) and adds the bearer-scheme
// parsing + dest->shop extraction + domain validation. This is the ONLY auth for the embedded admin
// API; the App-Proxy routes (/validate, /config) keep their own HMAC and never touch this. Pure
// (now injectable) so it is unit-tested without a request.
import { isValidShopDomain } from '../auth/oauth.js';
import { SessionTokenError, verifySessionToken } from '../security/sessionToken.js';

export type AdminSessionConfig = {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly now?: Date;
};

// Returns the verified myshopify domain, or throws SessionTokenError (→ 401 at the route).
export function shopFromBearer(authHeader: string | null, config: AdminSessionConfig): string {
  if (authHeader === null || !authHeader.startsWith('Bearer ')) {
    throw new SessionTokenError('Missing bearer token');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const verify =
    config.now === undefined ? { apiKey: config.apiKey, apiSecret: config.apiSecret } : config;
  const claims = verifySessionToken(token, verify);
  const shop = claims.dest.replace(/^https:\/\//, '').replace(/\/.*$/, '');
  if (!isValidShopDomain(shop)) {
    throw new SessionTokenError('Invalid token destination');
  }
  return shop;
}
