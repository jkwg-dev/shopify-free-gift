import type { FetchLike } from './config.js';
import { ShopifyHttpError } from './errors.js';

// OAuth authorization-code -> offline access token exchange (the install step). Kept here because
// all Shopify HTTP access lives in this package; the admin's OAuthTokenExchanger port wraps this.
// This is the standard offline grant (not client credentials): the token does not expire until the
// app is uninstalled.

export type AccessTokenExchangeInput = {
  // Verified *.myshopify.com domain (the caller validates it before calling).
  readonly shop: string;
  readonly code: string;
  readonly apiKey: string; // Client ID
  readonly apiSecret: string; // Client secret
};

export type AccessTokenResult = {
  readonly accessToken: string;
  readonly scopes: string;
};

type TokenResponse = {
  readonly access_token?: string;
  readonly scope?: string;
};

export async function exchangeAccessToken(
  fetch: FetchLike,
  input: AccessTokenExchangeInput,
): Promise<AccessTokenResult> {
  const response = await fetch(`https://${input.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: input.apiKey,
      client_secret: input.apiSecret,
      code: input.code,
    }),
  });

  if (!response.ok) {
    throw new ShopifyHttpError(response.status, await response.text());
  }

  const body = (await response.json()) as TokenResponse;
  if (body.access_token === undefined || body.access_token.length === 0) {
    throw new ShopifyHttpError(response.status, 'OAuth token exchange returned no access_token');
  }
  return { accessToken: body.access_token, scopes: body.scope ?? '' };
}
