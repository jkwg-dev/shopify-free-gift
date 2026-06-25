import type { RateLimiter } from './rateLimit.js';

// Shared, cross-instance fixed-window rate limiter for serverless (Vercel). The counter increment
// MUST be atomic — a read-then-write leaks the limit under concurrency (the same race the mapping
// store already handles). Atomicity lives in a SINGLE SQL statement at the composition root:
//
//   INSERT INTO "rate_limits" ("bucketKey","windowStart","count") VALUES ($1,$2,1)
//   ON CONFLICT ("bucketKey","windowStart") DO UPDATE SET "count" = "rate_limits"."count" + 1
//   RETURNING "count"
//
// This adapter depends only on that atomic increment (the WindowCounter port), so it stays free of
// Prisma and is unit-testable; the route depends only on RateLimiter.

export interface WindowCounter {
  // Atomically increment the counter for (bucketKey, windowStart) and return the NEW count.
  increment(bucketKey: string, windowStart: number): Promise<number>;
}

export type PostgresRateLimiterOptions = {
  readonly limit: number;
  readonly windowMs: number;
  // Injected clock (Date.now in production) so windows are deterministic under test.
  readonly now: () => number;
  readonly counter: WindowCounter;
};

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly options: PostgresRateLimiterOptions) {}

  async take(key: string): Promise<boolean> {
    // Window start is computed server-side (never client-supplied) so buckets are deterministic.
    const windowStart =
      Math.floor(this.options.now() / this.options.windowMs) * this.options.windowMs;
    const count = await this.options.counter.increment(key, windowStart);
    return count <= this.options.limit;
  }
}
