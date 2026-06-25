// Shared test-only helpers (imported by *.test.ts, never re-exported from the package barrel).
import type { FetchLike, HttpResponse, ShopifyConfig } from './config.js';

export type StubResponse = {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
};

export type CapturedCall = {
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; body: string };
};

// A fetch stub that returns the queued responses in order and records every call. Throws if a
// call is made past the end of the queue, so tests can't accidentally under-specify responses.
export function mockFetch(responses: readonly StubResponse[]): {
  fetch: FetchLike;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    if (index >= responses.length) {
      throw new Error(`mockFetch: unexpected call #${index + 1} (only ${responses.length} queued)`);
    }
    const stub = responses[index] as StubResponse;
    index += 1;
    const response: HttpResponse = {
      ok: stub.ok ?? true,
      status: stub.status ?? 200,
      json: () => Promise.resolve(stub.body),
      text: () => Promise.resolve(stub.text ?? ''),
    };
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

// Parse the JSON body a captured call posted to the Admin API.
export function parseBody(call: CapturedCall): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(call.init.body) as { query: string; variables: Record<string, unknown> };
}

export function testConfig(
  fetch: FetchLike,
  overrides: Partial<ShopifyConfig> = {},
): ShopifyConfig {
  return {
    shopDomain: 'our-store.myshopify.com',
    accessToken: 'shpat_test_token',
    apiVersion: '2026-04',
    fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}
