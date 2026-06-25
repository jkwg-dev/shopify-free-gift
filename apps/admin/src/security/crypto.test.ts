import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, TokenDecryptionError } from './crypto.js';

const key = randomBytes(32).toString('base64');

describe('token encryption', () => {
  it('round-trips a token', () => {
    const token = 'shpat_offline_access_token_value';
    expect(decryptToken(encryptToken(token, key), key)).toBe(token);
  });

  it('produces a versioned 4-part envelope and never the plaintext', () => {
    const blob = encryptToken('secret', key);
    expect(blob.split('.')).toHaveLength(4);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('secret');
  });

  it('rejects tampered ciphertext', () => {
    const blob = encryptToken('secret', key);
    const parts = blob.split('.');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3]!, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join('.');
    expect(() => decryptToken(tampered, key)).toThrow(TokenDecryptionError);
  });

  it('rejects a wrong key', () => {
    const blob = encryptToken('secret', key);
    const otherKey = randomBytes(32).toString('base64');
    expect(() => decryptToken(blob, otherKey)).toThrow(TokenDecryptionError);
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptToken('not-a-valid-blob', key)).toThrow(TokenDecryptionError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptToken('secret', randomBytes(16).toString('base64'))).toThrow();
  });
});
