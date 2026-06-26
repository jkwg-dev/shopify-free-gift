import { describe, expect, it } from 'vitest';
import { PENDING_DELAY_MS, PENDING_MAX_MS, pendingHint } from './pending.js';

describe('pendingHint (pure)', () => {
  it('first load (no confirmed result) reads "Loading…"', () => {
    expect(pendingHint(false)).toBe('Loading your free gift…');
  });
  it('an update to a known state reads "Updating…"', () => {
    expect(pendingHint(true)).toBe('Updating your free gift…');
  });
});

describe('pending timing constants', () => {
  it('engages after a flicker delay and is capped by a safety timeout', () => {
    expect(PENDING_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(PENDING_DELAY_MS).toBeLessThanOrEqual(400);
    expect(PENDING_MAX_MS).toBeGreaterThan(PENDING_DELAY_MS);
  });
});
