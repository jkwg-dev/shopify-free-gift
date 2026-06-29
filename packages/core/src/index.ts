// Business rules for the free-gift engine — pure functions, no I/O. The only place tier
// resolution, gift selection (OR/AND), suppression, decline, and schedule checks live.

export {
  addMoney,
  compareMoney,
  CurrencyMismatchError,
  isAtLeast,
  money,
  multiplyMoney,
  type Money,
} from './money.js';

export { computeQualifyingSubtotal, type CartLine } from './cart.js';

export {
  InvalidGiftChoiceError,
  resolveGiftSet,
  type Gift,
  type GiftConfig,
  type GiftOption,
} from './gifts.js';

export {
  applySuppression,
  resolveQualifiedTiers,
  type SuppressionMode,
  type Tier,
} from './tiers.js';

export { isCampaignActive, type Schedule } from './schedule.js';

// Shared gift-availability predicate (Stage E): one source of truth for "is this gift offerable",
// used by both the storefront /config builder and the admin greying endpoint.
export {
  giftOfferability,
  type GiftAvailability,
  type GiftAvailabilitySignals,
  type GiftUnavailableReason,
} from './giftAvailability.js';

export {
  validateCampaignConfig,
  type TierConfigForValidation,
  type ConfigIssue,
  type ConfigIssueCode,
} from './configValidation.js';

export { sha256Hex } from './hash.js';

export {
  configVersionHash,
  resolvedGiftSetHash,
  type ConfigVersionInput,
  type ConfigVersionTier,
} from './minting.js';

export {
  resolveActiveGifts,
  type Campaign,
  type ResolveInput,
  type ResolveResult,
  type ResolvedTierGift,
} from './resolve.js';

// Shared /validate wire contract (server in apps/admin, client in extensions/theme).
export type {
  ValidateCartLineInput,
  ValidateRequest,
  ValidateResult,
  ValidateNoGiftReason,
  ValidateError,
  ValidateErrorCode,
} from './validate.js';

// Read-only campaign-config contract for the perception UI (Phase 5b-2); separate from /validate.
export type {
  GiftOptionView,
  GiftItemView,
  TierConfig,
  CampaignConfigResponse,
  CampaignConfigRequest,
} from './campaignConfig.js';

// Pure storefront gift-line reconciliation (Phase 5a).
export {
  reconcileGiftLines,
  GIFT_LINE_PROPERTY,
  type CartLineView,
  type GiftLineAdd,
  type GiftLineRemoval,
  type GiftLineQuantityFix,
  type GiftReconciliation,
} from './reconcile.js';
