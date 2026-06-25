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
  return errors.map((e) =>
    e.extensions?.code === undefined
      ? { message: e.message }
      : { message: e.message, code: e.extensions.code },
  );
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

  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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

      if (errors.length > 0) {
        if (isThrottled(errors)) {
          if (attempt >= this.maxRetries) {
            throw new ShopifyThrottledError(attempt + 1);
          }
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ShopifyGraphqlError(toDetails(errors));
      }

      if (body.data === undefined) {
        throw new ShopifyGraphqlError([{ message: 'Admin API returned no data' }]);
      }
      return body.data;
    }
  }
}
