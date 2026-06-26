// Theme app extension public surface (Phase 5a): the /validate client and the variant-level choice
// model. The pure cart reconciler lives in @free-gift-engine/core (reconcileGiftLines). The live
// AJAX-cart wiring, perception UI, chooser/decline UI, and /discount/CODE application are Phase 5b.
export {
  postValidate,
  DEFAULT_PROXY_PATH,
  type ValidateClientResponse,
  type PostValidateOptions,
} from './validateClient.js';

export {
  groupGiftOptionsByProduct,
  defaultGiftChoices,
  type GiftOptionView,
  type GiftProductGroup,
} from './choices.js';

// Read-only campaign-config client + the chooser/decline renderer (Phase 5b-2a).
export {
  getConfig,
  DEFAULT_CONFIG_PATH,
  type ConfigClientResponse,
  type GetConfigOptions,
} from './configClient.js';
export {
  applyCartPlan,
  failedAddVariantIds,
  type CartPost,
  type PostResponse,
  type CartMutationResult,
  type CartMutationFailure,
} from './cartMutations.js';
export {
  renderChooser,
  buildChooserModel,
  type ChooserState,
  type ChooserHandlers,
  type ChooserModel,
  type ChooserTier,
  type ChooserOrTier,
  type ChooserAndTier,
} from './chooser.js';

// Tier progress graph (authoritative-only) + cart section mount for drawer & /cart page (Phase 5b-2b-1).
export {
  buildProgressModel,
  renderProgress,
  giftLabelFor,
  stepperLayout,
  type ProgressModel,
  type ProgressTierView,
  type ProgressNext,
  type StepNode,
  type StepAlign,
} from './progressGraph.js';
export {
  mountCartContexts,
  planInsertions,
  type CartSection,
  type CartMountOptions,
  type Insertion,
  type AnchorPresence,
  type MountStrategy,
} from './cartSections.js';
export { injectStyles, FGE_CSS, FGE_STYLE_ID } from './styles.js';
export {
  pendingShouldClear,
  setCheckoutLocked,
  PENDING_MIN_MS,
  PENDING_MAX_MS,
} from './pending.js';

// Convergent reconcile loop (re-read -> re-validate -> apply until stable) — Phase 5b-2a fix.
export { reconcileGiftCart, type GiftCartIo, type ReconcileOutcome } from './reconcileLoop.js';

// Re-export the reconciler + contract from core so 5b imports a single widget surface.
export {
  reconcileGiftLines,
  GIFT_LINE_PROPERTY,
  type CartLineView,
  type GiftReconciliation,
  type GiftLineAdd,
  type GiftLineRemoval,
  type GiftLineQuantityFix,
  type ValidateRequest,
  type ValidateResult,
} from '@free-gift-engine/core';
