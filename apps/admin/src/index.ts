// Phase 3a public surface: the data layer + headless route-handler logic the Phase 3b Polaris UI
// consumes. No React here. Business rules live in @free-gift-engine/core; Shopify I/O in
// @free-gift-engine/shopify.

export * from './contract.js';
export * from './domain.js';
export * from './ports.js';

export {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  validateVariants,
  CampaignValidationError,
  type CampaignServiceDeps,
} from './services/campaign.js';
export { supersedeStaleDiscounts, type SupersedeDeps } from './services/supersede.js';

export {
  GiftCodeMappingStore,
  type GiftDiscountSpec,
  type GiftCodeMappingStoreOptions,
} from './store/giftCodeMapping.js';

export { encryptToken, decryptToken, TokenDecryptionError } from './security/crypto.js';
export { verifyOAuthHmac, verifyWebhookHmac, verifyAppProxyHmac } from './security/hmac.js';
export {
  verifySessionToken,
  SessionTokenError,
  type SessionTokenClaims,
  type VerifyOptions,
} from './security/sessionToken.js';
export { generateOpaqueCode } from './security/opaqueCode.js';

export {
  buildAuthorizeUrl,
  handleOAuthCallback,
  OAuthError,
  type AuthorizeUrlInput,
  type OAuthCallbackDeps,
} from './auth/oauth.js';

export {
  handleWebhook,
  WebhookAuthError,
  APP_UNINSTALLED,
  COMPLIANCE_TOPICS,
  type WebhookDeps,
  type WebhookRequest,
} from './webhooks/handlers.js';

export {
  PrismaShopRepository,
  PrismaCampaignRepository,
  PrismaGiftCodeMappingTable,
} from './db/repositories.js';
export { isPrismaUniqueViolation, type PrismaLike } from './db/prismaLike.js';

// --- Phase 4: /validate (public storefront endpoint behind a Shopify App Proxy) ---
export type {
  ValidateRequest,
  ValidateCartLineInput,
  ValidateResult,
  ValidateError,
  ValidateErrorCode,
} from './validate/contract.js';
export {
  resolveValidate,
  ValidateBadRequestError,
  type ActiveCampaignContext,
  type ValidateServiceDeps,
} from './validate/service.js';
export {
  handleValidate,
  type ValidateHttpRequest,
  type ValidateHttpResponse,
  type ValidateHandlerDeps,
} from './validate/handler.js';
export {
  FixedWindowRateLimiter,
  type RateLimiter,
  type FixedWindowOptions,
} from './validate/rateLimit.js';
export {
  PostgresRateLimiter,
  type WindowCounter,
  type PostgresRateLimiterOptions,
} from './validate/rateLimitPostgres.js';
export { ShopifyDiscountGatewayAdapter } from './gateways/shopifyDiscountGateway.js';
export { getValidateDeps } from './validate/composition.js';
