// Composition root for the /validate runtime slice (Vercel serverless, Node runtime). The ONLY
// place that constructs concrete adapters: the real PrismaClient, the Admin GraphQL client, the
// Shopify discount gateway, and the Postgres rate limiter. Everything downstream depends on ports
// (dependency inversion), so this file is pure wiring — not unit-tested; its pieces are.
//
// NOTE: this is the runtime slice only. No Polaris UI / App Bridge / tier editor here (Phase 3b).
import { PrismaClient } from '@prisma/client';
import { AdminGraphqlClient, fetchVariantPricing, type FetchLike } from '@free-gift-engine/shopify';
import type { PrismaLike } from '../db/prismaLike.js';
import {
  PrismaCampaignRepository,
  PrismaGiftCodeMappingTable,
  PrismaShopRepository,
} from '../db/repositories.js';
import { ShopifyDiscountGatewayAdapter } from '../gateways/shopifyDiscountGateway.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import type { ValidateHandlerDeps } from './handler.js';
import { PostgresRateLimiter, type WindowCounter } from './rateLimitPostgres.js';
import type { ActiveCampaignContext } from './service.js';

// Public-endpoint abuse guard: at most RATE_LIMIT requests per RATE_WINDOW_MS per shop+buyer.
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
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

// Singletons: serverless reuses warm instances, so we avoid opening a new pool/client per request.
let prismaSingleton: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  prismaSingleton ??= new PrismaClient();
  return prismaSingleton;
}

let depsSingleton: ValidateHandlerDeps | null = null;

export function getValidateDeps(): ValidateHandlerDeps {
  if (depsSingleton !== null) {
    return depsSingleton;
  }

  const prisma = getPrisma();
  // PrismaClient's generated delegates are a superset of the narrow PrismaLike port the repositories
  // depend on; the cast is the documented injection seam (see prismaLike.ts).
  const prismaLike = prisma as unknown as PrismaLike;

  const baseCurrency = requireEnv('SHOPIFY_BASE_CURRENCY');
  const client = new AdminGraphqlClient({
    shopDomain: requireEnv('SHOPIFY_SHOP_DOMAIN'),
    accessToken: requireEnv('SHOPIFY_ADMIN_ACCESS_TOKEN'),
    apiVersion: requireEnv('SHOPIFY_API_VERSION'),
    fetch: fetchLike,
  });

  const shopRepo = new PrismaShopRepository(prismaLike);
  const campaignRepo = new PrismaCampaignRepository(prismaLike);
  const mappingTable = new PrismaGiftCodeMappingTable(prismaLike);
  const mappingStore = new GiftCodeMappingStore(
    mappingTable,
    new ShopifyDiscountGatewayAdapter(client),
  );

  const resolveActiveCampaign = async (
    shopDomain: string,
  ): Promise<ActiveCampaignContext | null> => {
    const shop = await shopRepo.findByDomain(shopDomain);
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

  depsSingleton = {
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
  return depsSingleton;
}
