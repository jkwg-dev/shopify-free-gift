import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC verification for the two inbound Shopify trust boundaries: the OAuth callback (hex HMAC
// over the sorted query string) and webhooks (base64 HMAC over the raw request body). Both use
// HMAC-SHA256 keyed by the app's API secret and a constant-time comparison.

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

// Shopify signs the OAuth callback with a hex HMAC over the query params (excluding `hmac` and the
// legacy `signature`), sorted by key and joined as `key=value` with `&`.
export function verifyOAuthHmac(query: Record<string, string>, apiSecret: string): boolean {
  const provided = query['hmac'];
  if (provided === undefined) {
    return false;
  }
  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&');
  const digest = createHmac('sha256', apiSecret).update(message).digest('hex');
  return safeEqual(digest, provided);
}

// Webhooks are signed with a base64 HMAC over the RAW request body (verify before JSON parsing).
export function verifyWebhookHmac(rawBody: string, hmacHeader: string, apiSecret: string): boolean {
  const digest = createHmac('sha256', apiSecret).update(rawBody, 'utf8').digest('base64');
  return safeEqual(digest, hmacHeader);
}
