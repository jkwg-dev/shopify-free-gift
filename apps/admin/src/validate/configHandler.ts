// HTTP-agnostic handler for GET /apps/free-gift/config (App Proxy, Phase 5b-2). Same auth model as
// /validate: verify the App Proxy HMAC over the (signed) query string, then rate-limit per shop+buyer.
// verifyAppProxyHmac is method-agnostic — it signs the query params, and Shopify signs a forwarded GET
// query identically (sorted, key=value, no separator), so `country`/`currency` are SIGNED inputs, not
// trusted unsigned. GET with query params, no body. The Next route is a thin Request->Response adapter.
import type {
  CampaignConfigRequest,
  CampaignConfigResponse,
  ValidateError,
} from '@free-gift-engine/core';
import { verifyAppProxyHmac } from '../security/hmac.js';
import type { RateLimiter } from './rateLimit.js';
import { type ConfigServiceDeps, resolveCampaignConfig } from './configService.js';

export type ConfigHttpRequest = {
  readonly method: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
};

export type ConfigHttpResponse = {
  readonly status: number;
  readonly body: CampaignConfigResponse | ValidateError;
};

export type ConfigHandlerDeps = ConfigServiceDeps & {
  readonly apiSecret: string;
  readonly rateLimiter: RateLimiter;
  // Injectable for tests; defaults to the real App Proxy HMAC check.
  readonly verifySignature?: (
    query: Readonly<Record<string, string | readonly string[]>>,
    apiSecret: string,
  ) => boolean;
};

function err(
  status: number,
  code: ValidateError['error']['code'],
  message: string,
): ConfigHttpResponse {
  return { status, body: { error: { code, message } } };
}

function single(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) ? value[0] : undefined;
}

export async function handleConfig(
  req: ConfigHttpRequest,
  deps: ConfigHandlerDeps,
): Promise<ConfigHttpResponse> {
  if (req.method.toUpperCase() !== 'GET') {
    return err(405, 'INVALID_REQUEST', 'Method not allowed');
  }

  const verify = deps.verifySignature ?? verifyAppProxyHmac;
  if (!verify(req.query, deps.apiSecret)) {
    return err(401, 'UNAUTHORIZED', 'Invalid App Proxy signature');
  }

  const shop = single(req.query['shop']);
  if (shop === undefined) {
    return err(401, 'UNAUTHORIZED', 'Missing shop');
  }

  const customer = single(req.query['logged_in_customer_id']);
  const ip = req.headers['x-forwarded-for'];
  const rateKey = `${shop}:${customer && customer.length > 0 ? customer : (ip ?? 'anon')}`;
  if (!(await deps.rateLimiter.take(rateKey))) {
    return err(429, 'RATE_LIMITED', 'Too many requests');
  }

  const presentmentCurrency = single(req.query['currency']);
  const countryCode = single(req.query['country']);
  if (presentmentCurrency === undefined || presentmentCurrency.length === 0) {
    return err(400, 'INVALID_REQUEST', 'currency is required');
  }
  if (countryCode === undefined || countryCode.length === 0) {
    return err(400, 'INVALID_REQUEST', 'country is required');
  }

  const request: CampaignConfigRequest = { presentmentCurrency, countryCode };
  const result = await resolveCampaignConfig(shop, request, deps);
  return { status: 200, body: result };
}
