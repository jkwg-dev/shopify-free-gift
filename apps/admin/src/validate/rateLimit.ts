// Abuse guard for the public /validate endpoint. Code creation is already deduped by the gift-code
// mapping store, so this only needs to blunt spam/scraping, not enforce exact quotas. `take` is
// async because the production limiter is a SHARED, cross-instance store (Postgres — see
// PostgresRateLimiter): on Vercel serverless, instances rotate constantly, so an in-process counter
// is meaningless. The route depends only on this interface (dependency inversion), so the store is
// swappable (Postgres now, KV/Upstash later) without touching the handler.

export interface RateLimiter {
  // Resolves true if this call is within budget; false if the caller has exceeded the limit.
  take(key: string): Promise<boolean>;
}

export type FixedWindowOptions = {
  readonly limit: number;
  readonly windowMs: number;
  // Injected clock (Date.now in production) so windows are deterministic under test.
  readonly now: () => number;
};

// In-process fixed window. Suitable for tests and single-process/local use ONLY — NOT for serverless
// (use PostgresRateLimiter there).
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly options: FixedWindowOptions) {}

  take(key: string): Promise<boolean> {
    const now = this.options.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= this.options.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return Promise.resolve(true);
    }
    if (bucket.count >= this.options.limit) {
      return Promise.resolve(false);
    }
    bucket.count += 1;
    return Promise.resolve(true);
  }
}
