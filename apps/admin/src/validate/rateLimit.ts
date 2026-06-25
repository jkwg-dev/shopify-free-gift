// Lightweight abuse guard for the public /validate endpoint. Code creation is already deduped by
// the gift-code mapping store, so this only needs to blunt spam/scraping, not enforce exact quotas.
// The default is an in-memory fixed window — per process instance; a multi-instance deploy that
// needs a shared limit would inject a Redis-backed implementation of this same interface.

export interface RateLimiter {
  // True if this call is within budget; false if the caller has exceeded the limit.
  take(key: string): boolean;
}

export type FixedWindowOptions = {
  readonly limit: number;
  readonly windowMs: number;
  // Injected clock (Date.now in production) so windows are deterministic under test.
  readonly now: () => number;
};

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly options: FixedWindowOptions) {}

  take(key: string): boolean {
    const now = this.options.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= this.options.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.options.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}
