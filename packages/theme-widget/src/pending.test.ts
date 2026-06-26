import { describe, expect, it } from 'vitest';
import { PENDING_MIN_MS, PENDING_MAX_MS, pendingShouldClear } from './pending.js';

describe('pendingShouldClear (pure: clear at max(work-done, min-duration))', () => {
  it('stays engaged until BOTH the work is done and the min-duration elapsed', () => {
    expect(pendingShouldClear(false, false)).toBe(false); // just engaged
    expect(pendingShouldClear(true, false)).toBe(false); // fast work, still in the min-hold
    expect(pendingShouldClear(false, true)).toBe(false); // min elapsed but work still running
    expect(pendingShouldClear(true, true)).toBe(true); // both -> clear
  });
});

describe('pending timing constants', () => {
  it('holds for a minimum visible duration, capped by a longer safety timeout', () => {
    expect(PENDING_MIN_MS).toBeGreaterThanOrEqual(400);
    expect(PENDING_MIN_MS).toBeLessThanOrEqual(700);
    expect(PENDING_MAX_MS).toBeGreaterThan(PENDING_MIN_MS);
  });
});
