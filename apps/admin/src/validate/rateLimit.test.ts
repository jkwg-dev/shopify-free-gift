import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rateLimit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, then blocks within the window', () => {
    const t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 1000, now: () => t });

    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(false);
  });

  it('resets when the window rolls over', () => {
    let t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => t });

    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('k')).toBe(false);
    t += 1000;
    expect(limiter.take('k')).toBe(true);
  });

  it('tracks keys independently', () => {
    const t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => t });

    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });
});
