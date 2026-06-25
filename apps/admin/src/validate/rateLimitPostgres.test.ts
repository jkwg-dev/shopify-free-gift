import { describe, expect, it } from 'vitest';
import { PostgresRateLimiter, type WindowCounter } from './rateLimitPostgres.js';

// A fake counter that models the DB's atomic increment: each call increments the (bucket, window)
// cell and returns the new count. Because JS runs the increment to completion before the next
// awaited call observes it, this mirrors the single ON CONFLICT ... RETURNING statement's atomicity.
class FakeCounter implements WindowCounter {
  readonly cells = new Map<string, number>();

  increment(bucketKey: string, windowStart: number): Promise<number> {
    const k = `${bucketKey}|${windowStart}`;
    const next = (this.cells.get(k) ?? 0) + 1;
    this.cells.set(k, next);
    return Promise.resolve(next);
  }
}

describe('PostgresRateLimiter', () => {
  it('allows up to the limit, then blocks within the window', async () => {
    const limiter = new PostgresRateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => 5000,
      counter: new FakeCounter(),
    });

    expect(await limiter.take('shop:cust')).toBe(true);
    expect(await limiter.take('shop:cust')).toBe(true);
    expect(await limiter.take('shop:cust')).toBe(false);
  });

  it('uses a fresh bucket once the window rolls over', async () => {
    let now = 5000;
    const limiter = new PostgresRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => now,
      counter: new FakeCounter(),
    });

    expect(await limiter.take('k')).toBe(true);
    expect(await limiter.take('k')).toBe(false);
    now += 1000; // next window
    expect(await limiter.take('k')).toBe(true);
  });

  it('floors the window start deterministically (same window within windowMs)', async () => {
    const counter = new FakeCounter();
    let now = 5000;
    const limiter = new PostgresRateLimiter({ limit: 10, windowMs: 1000, now: () => now, counter });

    await limiter.take('k');
    now = 5999; // same 5000-window
    await limiter.take('k');

    expect(counter.cells.get('k|5000')).toBe(2);
    expect([...counter.cells.keys()]).toEqual(['k|5000']);
  });

  it('never exceeds the limit under concurrent calls on one bucket (atomic increment)', async () => {
    const limiter = new PostgresRateLimiter({
      limit: 5,
      windowMs: 1000,
      now: () => 5000,
      counter: new FakeCounter(),
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.take('k')));

    expect(results.filter((allowed) => allowed)).toHaveLength(5);
  });
});
