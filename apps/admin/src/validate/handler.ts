// HTTP-agnostic /validate handler: App Proxy signature → rate limit → parse/validate → resolve.
// Kept free of any web framework so it is fully unit-testable; the Next.js route handler that
// exposes it through the Shopify App Proxy (a same-origin /apps/... storefront endpoint) is a thin
// adapter mapping Request -> ValidateHttpRequest -> Response, added when the Next app is scaffolded.
//
// This is a PUBLIC storefront call: it cannot use an App Bridge session token, so every request is
// authenticated by verifying the App Proxy HMAC signature. Unsigned/invalid requests are rejected.
import { InvalidGiftChoiceError } from '@free-gift-engine/core';
import { verifyAppProxyHmac } from '../security/hmac.js';
import type { ValidateError, ValidateRequest, ValidateResult } from './contract.js';
import type { RateLimiter } from './rateLimit.js';
import { resolveValidate, ValidateBadRequestError, type ValidateServiceDeps } from './service.js';

export type ValidateHttpRequest = {
  readonly method: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
};

export type ValidateHttpResponse = {
  readonly status: number;
  readonly body: ValidateResult | ValidateError;
};

export type ValidateHandlerDeps = ValidateServiceDeps & {
  // App shared secret used to verify the App Proxy signature.
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
): ValidateHttpResponse {
  return { status, body: { error: { code, message } } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new ValidateBadRequestError(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new ValidateBadRequestError(`${field}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

// Strict parse of the client body. Everything here is a CLAIM that downstream resolution
// re-validates; this only enforces the wire shape so the service can trust types, not values.
function parseRequest(rawBody: string): ValidateRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ValidateBadRequestError('Body is not valid JSON');
  }
  if (!isObject(parsed)) {
    throw new ValidateBadRequestError('Body must be a JSON object');
  }
  const { cart, choices, declined, presentmentCurrency, countryCode } = parsed;

  if (!Array.isArray(cart)) {
    throw new ValidateBadRequestError('cart must be an array');
  }
  const lines = cart.map((raw, i) => {
    if (!isObject(raw)) {
      throw new ValidateBadRequestError(`cart[${i}] must be an object`);
    }
    if (typeof raw.variantId !== 'string' || raw.variantId.length === 0) {
      throw new ValidateBadRequestError(`cart[${i}].variantId must be a non-empty string`);
    }
    if (typeof raw.quantity !== 'number' || !Number.isInteger(raw.quantity) || raw.quantity < 0) {
      throw new ValidateBadRequestError(`cart[${i}].quantity must be a non-negative integer`);
    }
    if (typeof raw.appAdded !== 'boolean') {
      throw new ValidateBadRequestError(`cart[${i}].appAdded must be a boolean`);
    }
    return { variantId: raw.variantId, quantity: raw.quantity, appAdded: raw.appAdded };
  });

  if (typeof declined !== 'boolean') {
    throw new ValidateBadRequestError('declined must be a boolean');
  }
  if (typeof presentmentCurrency !== 'string' || presentmentCurrency.length === 0) {
    throw new ValidateBadRequestError('presentmentCurrency must be a non-empty string');
  }
  if (typeof countryCode !== 'string' || countryCode.length === 0) {
    throw new ValidateBadRequestError('countryCode must be a non-empty string');
  }

  return {
    cart: lines,
    choices: asStringRecord(choices, 'choices'),
    declined,
    presentmentCurrency,
    countryCode,
  };
}

function single(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) ? value[0] : undefined;
}

export async function handleValidate(
  req: ValidateHttpRequest,
  deps: ValidateHandlerDeps,
): Promise<ValidateHttpResponse> {
  if (req.method.toUpperCase() !== 'POST') {
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

  // Rate-limit per shop + buyer (logged-in customer if present, else forwarded IP).
  const customer = single(req.query['logged_in_customer_id']);
  const ip = req.headers['x-forwarded-for'];
  const rateKey = `${shop}:${customer && customer.length > 0 ? customer : (ip ?? 'anon')}`;
  if (!deps.rateLimiter.take(rateKey)) {
    return err(429, 'RATE_LIMITED', 'Too many requests');
  }

  let request: ValidateRequest;
  try {
    request = parseRequest(req.rawBody);
  } catch (e) {
    if (e instanceof ValidateBadRequestError) {
      return err(400, 'INVALID_REQUEST', e.message);
    }
    throw e;
  }

  try {
    const result = await resolveValidate(shop, request, deps);
    return { status: 200, body: result };
  } catch (e) {
    if (e instanceof ValidateBadRequestError || e instanceof InvalidGiftChoiceError) {
      return err(400, 'INVALID_REQUEST', e.message);
    }
    throw e;
  }
}
