// Typed Admin API wrappers — the only place Shopify/fetch access lives. All business logic
// stays in @free-gift-engine/core; this package is I/O. GraphQL Admin API only (REST is
// legacy), pinned to the SHOPIFY_API_VERSION supplied via config.

export {
  adminGraphqlEndpoint,
  type FetchLike,
  type HttpResponse,
  type ShopifyConfig,
} from './config.js';

export { AdminGraphqlClient } from './client.js';

export {
  GiftVariantValidationError,
  ShopifyGraphqlError,
  ShopifyHttpError,
  ShopifyThrottledError,
  ShopifyUserError,
  type GraphqlErrorDetail,
  type UserErrorDetail,
} from './errors.js';

export {
  currencyExponent,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  moneyToDecimalString,
} from './money.js';

export {
  createScopedGiftDiscount,
  deactivateDiscount,
  type CreatedDiscount,
  type DiscountCombinesWith,
  type ScopedGiftDiscountInput,
} from './discounts.js';

export { fetchGiftVariants, type GiftVariant } from './products.js';

export { fetchVariantPricing, type VariantPricing } from './pricing.js';

export {
  APP_UNINSTALLED_TOPIC,
  registerAppUninstalledWebhook,
  type WebhookSubscription,
} from './webhooks.js';
