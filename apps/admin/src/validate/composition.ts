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
  ALL_PRODUCTS_RULE,
  collectionProductCount,
  ensureQualifyingCollection,
  EXCLUDE_GIFTS_RULE,
  exchangeAccessToken,
  fetchGiftVariants,
  fetchVariantMeta,
  fetchVariantPricing,
  giftProductIdsForVariants,
  giftProductsMissingTag,
  tagProductsAsGift,
  untagProductsAsGift,
  waitForGiftProductsExcluded,
  waitForGiftProductsIncluded,
  type FetchLike,
  type QualifyingRule,
} from '@free-gift-engine/shopify';
import { ActiveCampaignNotEditableError } from '../admin/campaignValidation.js';
import {
  campaignToEditorView,
  editorInputToCampaignInput,
  giftVariantIdsOfCampaign,
} from '../admin/editorMapping.js';
import type { CampaignEditorInput, CampaignEditorView } from '../admin/editorTypes.js';
import { buildAuthorizeUrl, type OAuthCallbackDeps } from '../auth/oauth.js';
import type { CampaignResponse } from '../contract.js';
import type { Campaign } from '../domain.js';
import type { PrismaLike } from '../db/prismaLike.js';
import {
  PrismaCampaignRepository,
  PrismaGiftCodeMappingTable,
  PrismaShopRepository,
} from '../db/repositories.js';
import { ShopifyDiscountGatewayAdapter } from '../gateways/shopifyDiscountGateway.js';
import {
  createCampaign,
  getCampaign,
  updateCampaign,
  type CampaignServiceDeps,
} from '../services/campaign.js';
import type { GiftTagGateway } from '../services/giftLifecycle.js';
import type { OAuthTokenExchanger, ShopifyDiscountGateway } from '../ports.js';
import { decryptToken } from '../security/crypto.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import type { WebhookDeps } from '../webhooks/handlers.js';
import type { ConfigHandlerDeps } from './configHandler.js';
import type { ValidateHandlerDeps } from './handler.js';
import { PostgresRateLimiter, type WindowCounter } from './rateLimitPostgres.js';
import type { ActiveCampaignContext } from './service.js';

// Minimal access scopes the engine actually uses (audited against packages/shopify):
//   read_products   — gift-variant validation (fetchGiftVariants) + contextualPricing reads
//   write_products  — tag gift products (GIFT_TAG) so they drop out of the qualifying
//                     smart collection, and create that collection (BXGY customerBuys scope)
//   write_discounts — create/deactivate the BXGY gift codes
//   read_discounts  — the Admin discounts API requires it (we read the created code node back)
// Adding write_products requires re-consent/reinstall on the store (scope change). This must match
// [access_scopes] in shopify.app.toml and the Dev Dashboard app.
export const GIFT_ENGINE_SCOPES = 'read_products,write_products,write_discounts,read_discounts';

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Stage-1 model-C flag (the ONE source of truth for it). OFF (default) = today's exclusion behavior,
// perfectly inert. ON = gift products are INCLUDED in the qualifying collection (the all-products rule
// + the mint guard skip + un-tag provisioning). Set FGE_GIFTS_INCLUDED=true to flip; re-provision to
// apply (see docs/model-c-include-gifts-design.md).
export function giftsIncludedFlag(): boolean {
  return process.env['FGE_GIFTS_INCLUDED'] === 'true';
}
function qualifyingRule(): QualifyingRule {
  return giftsIncludedFlag() ? ALL_PRODUCTS_RULE : EXCLUDE_GIFTS_RULE;
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

// --- shared storefront wiring (used by both /validate and /config) -------------------------------

// Resolve the single active campaign for a verified shop domain (+ the shop's base currency).
function makeResolveActiveCampaign(
  baseCurrency: string,
): (domain: string) => Promise<ActiveCampaignContext | null> {
  const campaignRepo = new PrismaCampaignRepository(prismaLike());
  return async (domain: string): Promise<ActiveCampaignContext | null> => {
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
}

// Shared Postgres-backed rate limiter (atomic fixed-window increment; ON CONFLICT makes it race-safe).
function makeRateLimiter(prisma: PrismaClient): PostgresRateLimiter {
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
  return new PostgresRateLimiter({
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    now: () => Date.now(),
    counter,
  });
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

  const mappingTable = new PrismaGiftCodeMappingTable(prismaLike());
  const client = await adminClientForShop(shopDomain);
  const mappingStore = new GiftCodeMappingStore(
    mappingTable,
    new ShopifyDiscountGatewayAdapter(client, giftsIncludedFlag()),
  );
  // The BXGY codes reference the shared qualifying collection; ensure it exists with the rule for the
  // active model (exclude gifts vs all-products). Read-only here — the RULE FLIP is reconciled by
  // provisioning (getGiftTagGateway), so this never mutates an existing collection.
  const qualifyingCollection = await ensureQualifyingCollection(client, { rule: qualifyingRule() });

  validateDeps = {
    apiSecret: requireEnv('SHOPIFY_API_SECRET'),
    rateLimiter: makeRateLimiter(prisma),
    resolveActiveCampaign: makeResolveActiveCampaign(baseCurrency),
    priceVariants: (ids, ctx) => fetchVariantPricing(client, ids, ctx),
    mappingStore,
    qualifyingCollectionId: qualifyingCollection.id,
    now: () => new Date(),
  };
  return validateDeps;
}

// --- embedded admin (Phase 3b Stage A) -----------------------------------------------------------

// API key + secret used to VERIFY the App Bridge session token on embedded admin API calls.
export function getAdminSessionConfig(): { readonly apiKey: string; readonly apiSecret: string } {
  return { apiKey: requireEnv('SHOPIFY_API_KEY'), apiSecret: requireEnv('SHOPIFY_API_SECRET') };
}

// Read-only: all campaigns for a (session-verified) shop domain, for the admin list. Empty if the
// shop isn't installed. Read path only — no provisioning/activation (Stage C).
export async function listCampaignsByDomain(shopDomain: string): Promise<readonly Campaign[]> {
  const shop = await shopRepo().findByDomain(shopDomain);
  if (shop === null) {
    return [];
  }
  return new PrismaCampaignRepository(prismaLike()).listByShop(shop.id);
}

// --- embedded admin: campaign editor (Phase 3b Stage B) ------------------------------------------

// Build the service deps for a campaign WRITE: the campaign repo, a variant-liveness gateway backed
// by read_products, and the supersede deps (mapping table + discount gateway). For an inactive draft
// supersede is a no-op (no active codes), so no Shopify write happens — but the deps are wired so the
// same path serves Stage C activation later.
async function campaignServiceDeps(shopDomain: string): Promise<CampaignServiceDeps> {
  const client = await adminClientForShop(shopDomain);
  return {
    campaignRepo: new PrismaCampaignRepository(prismaLike()),
    variantGateway: {
      fetch: async (ids) =>
        (await fetchGiftVariants(client, ids)).map((v) => ({
          id: v.id,
          title: v.title,
          availableForSale: v.availableForSale,
        })),
    },
    mappingTable: new PrismaGiftCodeMappingTable(prismaLike()),
    gateway: new ShopifyDiscountGatewayAdapter(client, giftsIncludedFlag()),
  };
}

// Display label for a gift variant in the editor: the product title, plus the variant option value
// when it isn't Shopify's single-variant sentinel.
function variantLabel(meta: { productTitle: string; variantTitle: string }): string {
  return meta.variantTitle === 'Default Title'
    ? meta.productTitle
    : `${meta.productTitle} – ${meta.variantTitle}`;
}

// Resolve display titles for a campaign's gift variants (best-effort; a deleted variant is omitted
// and the view falls back to its id). Uses fetchVariantMeta, which does NOT throw on dead variants.
async function giftVariantTitles(
  shopDomain: string,
  campaign: CampaignResponse,
): Promise<Map<string, string>> {
  const ids = giftVariantIdsOfCampaign(campaign);
  if (ids.length === 0) {
    return new Map();
  }
  const client = await adminClientForShop(shopDomain);
  const meta = await fetchVariantMeta(client, ids);
  return new Map(meta.map((m) => [m.id, variantLabel(m)]));
}

// Create an inactive draft campaign for a (session-verified) shop. The service validates shape +
// suppression + schedule and checks variant liveness; the repo persists with active=false. Throws
// typed errors (CampaignConfigError / CampaignValidationError / EditorParseError) the route maps.
export async function createCampaignDraft(
  shopDomain: string,
  input: CampaignEditorInput,
): Promise<CampaignResponse> {
  const shop = await shopRepo().findByDomain(shopDomain);
  if (shop === null) {
    throw new Error(`Shop not installed: ${shopDomain}`);
  }
  const dto = editorInputToCampaignInput(input); // may throw EditorParseError
  return createCampaign(shop.id, dto, await campaignServiceDeps(shopDomain));
}

// Load one campaign as an editor view (decimals + display titles). Returns null when it doesn't
// exist or isn't owned by this shop (the route 404s, never leaking another shop's campaign).
export async function getCampaignEditorView(
  shopDomain: string,
  campaignId: string,
): Promise<CampaignEditorView | null> {
  const shop = await shopRepo().findByDomain(shopDomain);
  if (shop === null) {
    return null;
  }
  const campaign = await getCampaign(campaignId, {
    campaignRepo: new PrismaCampaignRepository(prismaLike()),
  });
  if (campaign === null || campaign.shopId !== shop.id) {
    return null;
  }
  return campaignToEditorView(campaign, await giftVariantTitles(shopDomain, campaign));
}

// Update an inactive draft. Ownership-checked (null -> 404); refuses to edit an ACTIVE campaign in
// Stage B (throws ActiveCampaignNotEditableError -> 400) so the live campaign's codes are never
// superseded out from under it before Stage C builds activation/teardown.
export async function updateCampaignDraft(
  shopDomain: string,
  campaignId: string,
  input: CampaignEditorInput,
): Promise<CampaignResponse | null> {
  const shop = await shopRepo().findByDomain(shopDomain);
  if (shop === null) {
    return null;
  }
  const deps = await campaignServiceDeps(shopDomain);
  const existing = await deps.campaignRepo.findById(campaignId);
  if (existing === null || existing.shopId !== shop.id) {
    return null;
  }
  if (existing.active) {
    throw new ActiveCampaignNotEditableError(campaignId);
  }
  const dto = editorInputToCampaignInput(input); // may throw EditorParseError
  return updateCampaign(campaignId, dto, deps);
}

// --- /config (read-only campaign structure for the perception UI) --------------------------------

let configDeps: ConfigHandlerDeps | null = null;

export async function getConfigDeps(): Promise<ConfigHandlerDeps> {
  if (configDeps !== null) {
    return configDeps;
  }
  const prisma = getPrisma();
  const shopDomain = requireEnv('SHOPIFY_SHOP_DOMAIN');
  const baseCurrency = requireEnv('SHOPIFY_BASE_CURRENCY');
  const client = await adminClientForShop(shopDomain);

  configDeps = {
    apiSecret: requireEnv('SHOPIFY_API_SECRET'),
    rateLimiter: makeRateLimiter(prisma),
    resolveActiveCampaign: makeResolveActiveCampaign(baseCurrency),
    priceVariants: (ids, ctx) => fetchVariantPricing(client, ids, ctx),
    fetchVariantMeta: (ids) => fetchVariantMeta(client, ids),
  };
  return configDeps;
}

// --- Gift-product tag lifecycle (BXGY provisioning) ----------------------------------------------

// Wires the GiftTagGateway port to packages/shopify for the single store. Used by the campaign
// provisioning/teardown flow (provisionGifts / reconcileGiftTagsOnTeardown) — Phase 5b Step 3.
export async function getGiftTagGateway(): Promise<GiftTagGateway> {
  const client = await adminClientForShop(requireEnv('SHOPIFY_SHOP_DOMAIN'));
  return {
    // Provisioning is the rule authority: apply the active model's rule AND reconcile (flip) an
    // existing collection in place when the flag is ON.
    ensureQualifyingCollection: () =>
      ensureQualifyingCollection(client, {
        rule: qualifyingRule(),
        reconcileExisting: giftsIncludedFlag(),
      }),
    resolveGiftProductIds: (variantIds) => giftProductIdsForVariants(client, variantIds),
    tagProductsAsGift: (productIds) => tagProductsAsGift(client, productIds),
    untagProductsAsGift: (productIds) => untagProductsAsGift(client, productIds),
    verifyGiftProductsTagged: (productIds) => giftProductsMissingTag(client, productIds),
    collectionProductCount: (collectionId) => collectionProductCount(client, collectionId),
    waitForGiftProductsExcluded: (collectionId, productIds) =>
      waitForGiftProductsExcluded(client, collectionId, productIds),
    waitForGiftProductsIncluded: (collectionId, productIds) =>
      waitForGiftProductsIncluded(client, collectionId, productIds),
  };
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
      return new ShopifyDiscountGatewayAdapter(
        client,
        giftsIncludedFlag(),
      ).createScopedGiftDiscount(input);
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
