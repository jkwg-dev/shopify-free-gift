import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rateLimit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, then blocks within the window', async () => {
    const t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 1000, now: () => t });

    expect(await limiter.take('k')).toBe(true);
    expect(await limiter.take('k')).toBe(true);
    expect(await limiter.take('k')).toBe(true);
    expect(await limiter.take('k')).toBe(false);
  });

  it('resets when the window rolls over', async () => {
    let t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => t });

    expect(await limiter.take('k')).toBe(true);
    expect(await limiter.take('k')).toBe(false);
    t += 1000;
    expect(await limiter.take('k')).toBe(true);
  });

  it('tracks keys independently', async () => {
    const t = 1000;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now: () => t });

    expect(await limiter.take('a')).toBe(true);
    expect(await limiter.take('b')).toBe(true);
    expect(await limiter.take('a')).toBe(false);
  });
});
