import type { Shop } from '../domain.js';
import type { OAuthTokenExchanger, ShopRepository } from '../ports.js';
import { encryptToken } from '../security/crypto.js';
import { verifyOAuthHmac } from '../security/hmac.js';

// Standard offline-token OAuth grant. Custom-distribution app: one offline token per shop, stored
// encrypted at rest. We verify the callback HMAC and the shop domain before exchanging.

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export type AuthorizeUrlInput = {
  readonly shop: string;
  readonly apiKey: string;
  readonly scopes: string;
  readonly redirectUri: string;
  readonly state: string;
};

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (!SHOP_DOMAIN.test(input.shop)) {
    throw new OAuthError(`Invalid shop domain: ${input.shop}`);
  }
  const params = new URLSearchParams({
    client_id: input.apiKey,
    scope: input.scopes,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${input.shop}/admin/oauth/authorize?${params.toString()}`;
}

export type OAuthCallbackDeps = {
  readonly apiSecret: string;
  readonly encryptionKey: string;
  readonly exchanger: OAuthTokenExchanger;
  readonly shopRepo: ShopRepository;
};

// Verify the callback (HMAC + shop domain), exchange the code for an offline token, encrypt it,
// and persist the install. The validated shop domain also guards the token-exchange request
// against being pointed at an attacker-controlled host.
export async function handleOAuthCallback(
  query: Record<string, string>,
  deps: OAuthCallbackDeps,
): Promise<Shop> {
  if (!verifyOAuthHmac(query, deps.apiSecret)) {
    throw new OAuthError('Invalid OAuth HMAC');
  }
  const shop = query['shop'];
  const code = query['code'];
  if (shop === undefined || code === undefined) {
    throw new OAuthError('Missing shop or code');
  }
  if (!SHOP_DOMAIN.test(shop)) {
    throw new OAuthError(`Invalid shop domain: ${shop}`);
  }

  const { accessToken, scopes } = await deps.exchanger.exchange(shop, code);
  return deps.shopRepo.upsertInstalled({
    domain: shop,
    encryptedAccessToken: encryptToken(accessToken, deps.encryptionKey),
    scopes,
  });
}
