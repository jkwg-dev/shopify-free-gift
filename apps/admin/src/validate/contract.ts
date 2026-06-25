// The frozen /validate wire contract now lives in @free-gift-engine/core, shared by this server
// route and the Phase 5 storefront client (both depend inward on core; neither imports the other).
// Re-exported here for back-compat so existing admin imports (`./contract.js`) keep working. The
// SHAPE is unchanged — only the home moved.
export type {
  ValidateCartLineInput,
  ValidateRequest,
  ValidateResult,
  ValidateError,
  ValidateErrorCode,
} from '@free-gift-engine/core';
