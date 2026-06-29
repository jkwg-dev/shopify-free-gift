import { adminGraphqlEndpoint, resolveSleep, type ShopifyConfig } from './config.js';
import {
  ShopifyGraphqlError,
  ShopifyHttpError,
  ShopifyThrottledError,
  type GraphqlErrorDetail,
} from './errors.js';

type RawGraphqlError = {
  readonly message: string;
  readonly extensions?: { readonly code?: string };
  readonly path?: readonly (string | number)[];
};

type GraphqlResponse<T> = {
  readonly data?: T;
  readonly errors?: readonly RawGraphqlError[];
};

const DEFAULT_MAX_RETRIES = 3;

function isThrottled(errors: readonly RawGraphqlError[]): boolean {
  return errors.some((e) => e.extensions?.code === 'THROTTLED');
}

function toDetails(errors: readonly RawGraphqlError[]): GraphqlErrorDetail[] {
  return errors.map((e) => ({
    message: e.message,
    ...(e.extensions?.code !== undefined ? { code: e.extensions.code } : {}),
    ...(e.path !== undefined ? { path: e.path } : {}),
  }));
}

// The single choke point for Admin GraphQL access. Retries cost-based THROTTLED errors with
// exponential backoff; surfaces every other failure as a typed error (never swallowed).
export class AdminGraphqlClient {
  private readonly endpoint: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly config: ShopifyConfig) {
    this.endpoint = adminGraphqlEndpoint(config);
    this.sleep = resolveSleep(config);
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  // The shared transport: POST + HTTP-error + THROTTLED-retry, returning the RAW body (data AND/OR
  // errors). It throws only ShopifyHttpError and ShopifyThrottledError; the GraphQL-`errors[]` policy
  // is decided by the public method, so request() (strict) and requestPartial() (tolerant) cannot drift.
  private async fetchWithRetry<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphqlResponse<T>> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.config.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new ShopifyHttpError(response.status, await response.text());
      }

      const body = (await response.json()) as GraphqlResponse<T>;
      const errors = body.errors ?? [];
      if (errors.length > 0 && isThrottled(errors)) {
        if (attempt >= this.maxRetries) {
          throw new ShopifyThrottledError(attempt + 1);
        }
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      return body;
    }
  }

  // Strict: any non-throttle `errors[]` throws (the right default — nothing is partially trusted).
  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const body = await this.fetchWithRetry<T>(query, variables);
    const errors = body.errors ?? [];
    if (errors.length > 0) {
      throw new ShopifyGraphqlError(toDetails(errors));
    }
    if (body.data === undefined) {
      throw new ShopifyGraphqlError([{ message: 'Admin API returned no data' }]);
    }
    return body.data;
  }

  // Partial-tolerant: for queries where a per-node field error is expected and the surviving data is
  // still usable (e.g. a `nodes(ids:)` batch where one node's field errors and is nulled, but the
  // others resolve). Returns BOTH data and errors so the caller is contractually forced to inspect the
  // errors — nothing is silently swallowed. Still throws ShopifyHttpError / ShopifyThrottledError, and
  // ShopifyGraphqlError only when there is NEITHER data NOR errors to act on. Use sparingly: request()
  // (strict) stays the default for every other caller.
  async requestPartial<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ readonly data: T | undefined; readonly errors: readonly GraphqlErrorDetail[] }> {
    const body = await this.fetchWithRetry<T>(query, variables);
    const errors = toDetails(body.errors ?? []);
    if (body.data === undefined && errors.length === 0) {
      throw new ShopifyGraphqlError([{ message: 'Admin API returned no data' }]);
    }
    return { data: body.data, errors };
  }
}
