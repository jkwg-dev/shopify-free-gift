// Injected configuration for all Admin API access. The offline access token is supplied by
// the caller (custom-distribution app); this package never reads process.env directly and
// never hardcodes a token. Secure persistence of the token lands in Phase 3.

// Minimal HTTP response shape we depend on, so tests can mock without DOM/Node lib types.
export type HttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

// Injected fetch — the composition root passes the platform fetch; tests pass a stub.
// We do not default to a global so the package needs no DOM/Node typings.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponse>;

export type ShopifyConfig = {
  // e.g. our-store.myshopify.com
  readonly shopDomain: string;
  // Offline Admin API access token (Shopify-Access-Token header).
  readonly accessToken: string;
  // Pinned Admin API version, e.g. 2026-04.
  readonly apiVersion: string;
  readonly fetch: FetchLike;
  // Injected so retry backoff is testable (no real waiting in tests). Optional: defaults to
  // a setTimeout-based sleep resolved off globalThis to avoid ambient lib typings.
  readonly sleep?: (ms: number) => Promise<void>;
  // Max THROTTLED retries before giving up. Defaults to 3.
  readonly maxRetries?: number;
};

export function adminGraphqlEndpoint(config: ShopifyConfig): string {
  return `https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`;
}

const globalSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(resolve, ms);
  });

export function resolveSleep(config: ShopifyConfig): (ms: number) => Promise<void> {
  return config.sleep ?? globalSleep;
}
