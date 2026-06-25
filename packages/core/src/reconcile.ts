// Pure gift-line reconciliation — the testable heart of the storefront widget (Phase 5a). Given the
// current cart and the server's /validate result, compute the EXACT cart mutations: which app-added
// gift line(s) to ADD and which to REMOVE. No DOM, no fetch, no prices: the widget only manipulates
// cart lines; the minted code + Shopify discount set the $0, and the server already recomputed
// eligibility. Applying the result twice is a no-op (idempotent) — no flicker, no double-add.
import type { ValidateNoGiftReason, ValidateResult } from './validate.js';

// Line-item property that marks a cart line as APP-ADDED (a gift we injected). The widget sets this
// on add and reads it on cart load to derive `appAdded`. It is the sole signal the reconciler uses
// to decide a line is "ours" — a shopper's own paid line (no marker) is never touched, including a
// separately purchased unit of a gift-eligible variant (the paid-duplicate case).
export const GIFT_LINE_PROPERTY = '_fge_gift' as const;

// A cart line as the widget reads it from the theme. `id` is the theme's opaque line key (used to
// target a removal). `appAdded` is derived by the widget from GIFT_LINE_PROPERTY.
export type CartLineView = {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly appAdded: boolean;
};

export type GiftLineAdd = {
  readonly variantId: string;
  readonly quantity: 1; // gifts are always a single unit
  readonly properties: Readonly<Record<string, string>>; // carries the app-added marker
};

export type GiftLineRemoval = {
  readonly id: string;
  readonly variantId: string;
};

export type GiftReconciliation = {
  readonly add: readonly GiftLineAdd[];
  readonly remove: readonly GiftLineRemoval[];
  // The discount code to apply (status 'gift') or null — null SIGNALS the previously-applied code no
  // longer applies (declined, dropped below threshold, unavailable, etc.) and should be cleared.
  readonly applyCode: string | null;
  readonly status: ValidateResult['status'];
  // no-gift reason passthrough so 5b can message the shopper (e.g. 'gift-unavailable'); null on gift.
  readonly reason: ValidateNoGiftReason | null;
};

// Compute the cart mutations needed to make the cart match the server result.
// - Desired app-added gift lines = the resolved giftVariantIds (or none when no-gift).
// - REMOVE any app-added gift line whose variant is not desired (tier change, OR/variant change,
//   decline, dropped below threshold, gift-unavailable, cumulative-unsupported).
// - ADD any desired gift variant not already present as an app-added line.
// Variant-granular: matching is by variant GID, so Ice->Dawn (siblings of one product) removes Ice
// and adds Dawn, never collapsing by product. Idempotent: when the cart already matches, both lists
// are empty.
export function reconcileGiftLines(
  cart: readonly CartLineView[],
  result: ValidateResult,
): GiftReconciliation {
  const desired = result.status === 'gift' ? result.giftVariantIds : [];
  const appAddedGiftLines = cart.filter((line) => line.appAdded);
  const presentVariantIds = new Set(appAddedGiftLines.map((line) => line.variantId));

  const remove = appAddedGiftLines
    .filter((line) => !desired.includes(line.variantId))
    .map((line) => ({ id: line.id, variantId: line.variantId }));

  const add = desired
    .filter((variantId) => !presentVariantIds.has(variantId))
    .map((variantId) => ({
      variantId,
      quantity: 1 as const,
      properties: { [GIFT_LINE_PROPERTY]: '1' },
    }));

  return {
    add,
    remove,
    applyCode: result.status === 'gift' ? result.code : null,
    status: result.status,
    reason: result.status === 'no-gift' ? result.reason : null,
  };
}
