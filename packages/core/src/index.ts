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
