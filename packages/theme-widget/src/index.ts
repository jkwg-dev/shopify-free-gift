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

// Re-export the reconciler + contract from core so 5b imports a single widget surface.
export {
  reconcileGiftLines,
  GIFT_LINE_PROPERTY,
  type CartLineView,
  type GiftReconciliation,
  type GiftLineAdd,
  type GiftLineRemoval,
  type ValidateRequest,
  type ValidateResult,
} from '@free-gift-engine/core';
