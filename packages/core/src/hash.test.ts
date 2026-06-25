import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex — NIST vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the 56-byte two-block vector', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes a multi-block message (1,000,000 "a")', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('handles 2-, 3-, and 4-byte UTF-8 (é, €/中, 🎁)', () => {
    // Exercises every branch of the UTF-8 encoder: 1-byte ASCII, 2-byte (é), 3-byte (€, 中),
    // and a 4-byte surrogate pair (🎁).
    expect(sha256Hex('aé€中🎁')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('aé€中🎁')).toBe(sha256Hex('aé€中🎁'));
    expect(sha256Hex('aé€中🎁')).not.toBe(sha256Hex('aé€中'));
  });
});
