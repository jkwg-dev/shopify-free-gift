import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Authenticated encryption (AES-256-GCM) for the offline Admin API token at rest. The GCM auth
// tag makes tampering detectable: any change to IV, tag, or ciphertext fails decryption. The
// 32-byte key comes from a secret manager / env (base64), never hardcoded.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class TokenDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

function loadKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be 32 bytes (got ${key.length}); provide a base64 256-bit key`,
    );
  }
  return key;
}

// Returns "v1.<iv>.<tag>.<ciphertext>", each segment base64. The version prefix lets us rotate
// the scheme later without ambiguity.
export function encryptToken(plaintext: string, keyBase64: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(keyBase64), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptToken(blob: string, keyBase64: string): string {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenDecryptionError('Malformed or unsupported ciphertext envelope');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, loadKey(keyBase64), Buffer.from(ivB64!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64!, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // GCM auth failure (tampered ciphertext/tag/iv) or wrong key.
    throw new TokenDecryptionError('Token authentication failed — ciphertext may be tampered');
  }
}
