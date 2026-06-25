// Composition root for the runtime slice (Vercel serverless, Node runtime). The ONLY place that
// constructs concrete adapters: PrismaClient, the Admin GraphQL client, the Shopify discount +
// OAuth-exchange adapters, and the Postgres rate limiter. Everything downstream depends on ports
// (dependency inversion), so this file is pure wiring — not unit-tested; its pieces are.
//
// Auth model: standard OAuth authorization-code grant with an OFFLINE token (not client
// credentials). The token is obtained at install (app/api/auth/callback), encrypted at rest, and
// persisted to the Shop row. All Admin API calls USE that persisted token (decrypted per shop) —
// there is no static admin token in env. Runtime slice only: no Polaris UI / App Bridge (Phase 3b).
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  AdminGraphqlClient,
  exchangeAccessToken,
  fetchVariantPricing,
  type FetchLike,
} from '@free-gift-engine/shopify';
import { buildAuthorizeUrl, type OAuthCallbackDeps } from '../auth/oauth.js';
import type { PrismaLike } from '../db/prismaLike.js';
import {
  PrismaCampaignRepository,
  PrismaGiftCodeMappingTable,
  PrismaShopRepository,
} from '../db/repositories.js';
import { ShopifyDiscountGatewayAdapter } from '../gateways/shopifyDiscountGateway.js';
import type { OAuthTokenExchanger, ShopifyDiscountGateway } from '../ports.js';
import { decryptToken } from '../security/crypto.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import type { WebhookDeps } from '../webhooks/handlers.js';
import type { ValidateHandlerDeps } from './handler.js';
import { PostgresRateLimiter, type WindowCounter } from './rateLimitPostgres.js';
import type { ActiveCampaignContext } from './service.js';

// Minimal access scopes the engine actually uses (audited against packages/shopify):
//   read_products   — gift-variant validation (fetchGiftVariants) + contextualPricing reads
//   write_discounts — create/deactivate the scoped 100%-off codes
//   read_discounts  — the Admin discounts API requires it (we read the created code node back)
// We never create/modify products, so write_products is intentionally NOT requested. This must
// match [access_scopes] in shopify.app.toml and the Dev Dashboard app.
export const GIFT_ENGINE_SCOPES = 'read_products,write_discounts,read_discounts';

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Adapt the platform global fetch to the package's narrow FetchLike (no DOM lib types needed).
const fetchLike: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
};

// Singletons: serverless reuses warm instances, so avoid a new pool/client per request.
let prismaSingleton: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  prismaSingleton ??= new PrismaClient();
  return prismaSingleton;
}

// PrismaClient's generated delegates are a superset of the narrow PrismaLike port the repositories
// depend on; the cast is the documented injection seam (see prismaLike.ts).
function prismaLike(): PrismaLike {
  return getPrisma() as unknown as PrismaLike;
}

function shopRepo(): PrismaShopRepository {
  return new PrismaShopRepository(prismaLike());
}

// Build an Admin client for a shop using its PERSISTED, decrypted offline token. Single-store app,
// so the client is cached per domain. Throws if the shop is not installed (or uninstalled, unless
// allowed) — callers on the validate path require an installed shop; the webhook path tolerates it.
const clientCache = new Map<string, AdminGraphqlClient>();
async function adminClientForShop(
  shopDomain: string,
  opts: { allowUninstalled?: boolean } = {},
): Promise<AdminGraphqlClient> {
  const cached = clientCache.get(shopDomain);
  if (cached !== undefined) {
    return cached;
  }
  const shop = await shopRepo().findByDomain(shopDomain);
  if (shop === null) {
    throw new Error(`Shop not installed: ${shopDomain}`);
  }
  if (shop.uninstalledAt !== null && opts.allowUninstalled !== true) {
    throw new Error(`Shop uninstalled: ${shopDomain}`);
  }
  const accessToken = decryptToken(shop.encryptedAccessToken, requireEnv('TOKEN_ENCRYPTION_KEY'));
  const client = new AdminGraphqlClient({
    shopDomain,
    accessToken,
    apiVersion: requireEnv('SHOPIFY_API_VERSION'),
    fetch: fetchLike,
  });
  clientCache.set(shopDomain, client);
  return client;
}

// Install-state for the "/" entry route: a usable offline token exists iff the Shop row is present,
// not uninstalled, and its token decrypts. Never throws — any doubt returns false so "/" redirects
// to OAuth begin (safe for an already-installed shop). Reuses the 3a repo + crypto.
export async function isShopInstalled(shopDomain: string): Promise<boolean> {
  try {
    const shop = await shopRepo().findByDomain(shopDomain);
    if (shop === null || shop.uninstalledAt !== null) {
      return false;
    }
    decryptToken(shop.encryptedAccessToken, requireEnv('TOKEN_ENCRYPTION_KEY'));
    return true;
  } catch {
    return false;
  }
}

// --- /validate -----------------------------------------------------------------------------------

let validateDeps: ValidateHandlerDeps | null = null;

export async function getValidateDeps(): Promise<ValidateHandlerDeps> {
  if (validateDeps !== null) {
    return validateDeps;
  }
  const prisma = getPrisma();
  const shopDomain = requireEnv('SHOPIFY_SHOP_DOMAIN');
  const baseCurrency = requireEnv('SHOPIFY_BASE_CURRENCY');

  const campaignRepo = new PrismaCampaignRepository(prismaLike());
  const mappingTable = new PrismaGiftCodeMappingTable(prismaLike());
  const client = await adminClientForShop(shopDomain);
  const mappingStore = new GiftCodeMappingStore(
    mappingTable,
    new ShopifyDiscountGatewayAdapter(client),
  );

  const resolveActiveCampaign = async (domain: string): Promise<ActiveCampaignContext | null> => {
    const shop = await shopRepo().findByDomain(domain);
    if (shop === null) {
      return null;
    }
    const campaigns = await campaignRepo.listByShop(shop.id);
    const active = campaigns.find((c) => c.active);
    if (active === undefined) {
      return null;
    }
    return { shopId: shop.id, baseCurrency, campaign: active };
  };

  // Atomic fixed-window increment in one statement — the DB's ON CONFLICT makes it race-safe.
  const counter: WindowCounter = {
    async increment(bucketKey, windowStart) {
      const rows = await prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO "rate_limits" ("bucketKey", "windowStart", "count")
        VALUES (${bucketKey}, ${BigInt(windowStart)}, 1)
        ON CONFLICT ("bucketKey", "windowStart")
        DO UPDATE SET "count" = "rate_limits"."count" + 1
        RETURNING "count"
      `;
      return rows[0]?.count ?? 1;
    },
  };

  validateDeps = {
    apiSecret: requireEnv('SHOPIFY_API_SECRET'),
    rateLimiter: new PostgresRateLimiter({
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
      now: () => Date.now(),
      counter,
    }),
    resolveActiveCampaign,
    priceVariants: (ids, ctx) => fetchVariantPricing(client, ids, ctx),
    mappingStore,
    now: () => new Date(),
  };
  return validateDeps;
}

// --- OAuth install -------------------------------------------------------------------------------

// Build the Shopify authorize URL for the install redirect. The single client secret
// (SHOPIFY_API_SECRET) later verifies the callback HMAC; the offline token is exchanged + persisted.
export function buildInstallRedirect(shop: string): string {
  const appUrl = requireEnv('SHOPIFY_APP_URL').replace(/\/$/, '');
  return buildAuthorizeUrl({
    shop,
    apiKey: requireEnv('SHOPIFY_API_KEY'),
    scopes: process.env['SHOPIFY_SCOPES'] ?? GIFT_ENGINE_SCOPES,
    redirectUri: `${appUrl}/api/auth/callback`,
    state: randomUUID(),
  });
}

export function getOAuthCallbackDeps(): OAuthCallbackDeps {
  const exchanger: OAuthTokenExchanger = {
    exchange: (shop, code) =>
      exchangeAccessToken(fetchLike, {
        shop,
        code,
        apiKey: requireEnv('SHOPIFY_API_KEY'),
        apiSecret: requireEnv('SHOPIFY_API_SECRET'),
      }),
  };
  return {
    apiSecret: requireEnv('SHOPIFY_API_SECRET'),
    encryptionKey: requireEnv('TOKEN_ENCRYPTION_KEY'),
    exchanger,
    shopRepo: shopRepo(),
  };
}

// --- Webhooks ------------------------------------------------------------------------------------

// The gateway is LAZY: it builds the Admin client only when actually used, which is after
// handleWebhook has verified the HMAC (the gateway is touched solely by the app/uninstalled path).
// Remote deactivation is best-effort (token may already be revoked); the handler catches failures.
export function getWebhookDeps(shopDomain: string): WebhookDeps {
  const gateway: ShopifyDiscountGateway = {
    async createScopedGiftDiscount(input) {
      const client = await adminClientForShop(shopDomain, { allowUninstalled: true });
      return new ShopifyDiscountGatewayAdapter(client).createScopedGiftDiscount(input);
    },
    async deactivateDiscount(id) {
      const client = await adminClientForShop(shopDomain, { allowUninstalled: true });
      return new ShopifyDiscountGatewayAdapter(client).deactivateDiscount(id);
    },
  };
  return {
    apiSecret: requireEnv('SHOPIFY_API_SECRET'),
    shopRepo: shopRepo(),
    mappingTable: new PrismaGiftCodeMappingTable(prismaLike()),
    gateway,
  };
}
