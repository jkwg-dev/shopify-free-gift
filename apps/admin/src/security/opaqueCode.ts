import { randomBytes } from 'node:crypto';

// Crypto-strong, URL-safe opaque discount code (applied by the theme via /discount/CODE). Not
// human-friendly by design — the code is the secret that grants the gift, so it must be
// unguessable. base64url yields only [A-Za-z0-9_-], all URL-safe.
export function generateOpaqueCode(byteLength = 18): string {
  return randomBytes(byteLength).toString('base64url');
}
