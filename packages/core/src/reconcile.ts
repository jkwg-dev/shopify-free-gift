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
  // Minor-unit final price after discounts. When present, the reconciler treats a charged gift
  // (finalLinePrice > 0) as removable — a $0 copy is always preferred. Optional so existing
  // callers that don't supply it still work (treated as 0, i.e. "free").
  readonly finalLinePrice?: number;
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

// A present-and-desired gift line whose quantity drifted from 1 (a duplicate-add race bumped it);
// correct it back to exactly 1 unit. The `id` is the theme line key to target.
export type GiftLineQuantityFix = {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: 1;
};

export type GiftReconciliation = {
  readonly add: readonly GiftLineAdd[];
  readonly remove: readonly GiftLineRemoval[];
  // Present-and-desired gift lines to re-set to qty 1 (a rapid double-add bumped the quantity).
  readonly adjust: readonly GiftLineQuantityFix[];
  // The discount code to apply (status 'gift') or null — null SIGNALS the previously-applied code no
  // longer applies (declined, dropped below threshold, unavailable, etc.) and should be cleared.
  readonly applyCode: string | null;
  readonly status: ValidateResult['status'];
  // no-gift reason passthrough so 5b can message the shopper (e.g. 'gift-unavailable'); null on gift.
  readonly reason: ValidateNoGiftReason | null;
};

// Compute the cart mutations needed to NORMALIZE the cart to EXACTLY the server's desired gift set —
// one app-added line per desired variant at qty 1, and nothing else app-added. The desired set is the
// resolved (highest) tier's gift(s) only (`giftVariantIds`), or none when no-gift — so a previous
// tier's gift is always removed (highest-tier-only). Specifically, for the app-added gift lines:
//   - variant NOT desired           -> REMOVE (tier change, OR/variant change, decline, drop, etc.)
//   - variant desired, FIRST seen   -> KEEP; if qty != 1, ADJUST to 1 (undo a double-add quantity bump)
//   - variant desired, DUPLICATE    -> REMOVE the extra line (a rapid race split it into >1 line)
//   - desired variant with NO line  -> ADD it (qty 1)
// Variant-granular (by GID): Ice->Dawn removes Ice + adds Dawn, never collapsing by product. Fully
// IDEMPOTENT and convergent: applied to an already-normalized cart, all of add/remove/adjust are empty;
// applied to a messy cart (stacked qty, split lines, stale tier gifts) it converges it in one pass.
export function reconcileGiftLines(
  cart: readonly CartLineView[],
  result: ValidateResult,
): GiftReconciliation {
  const desired = result.status === 'gift' ? result.giftVariantIds : [];
  const desiredSet = new Set(desired);
  const appAddedGiftLines = cart.filter((line) => line.appAdded);

  const remove: GiftLineRemoval[] = [];
  const adjust: GiftLineQuantityFix[] = [];
  const kept = new Set<string>(); // desired variants already covered by a kept line (dedup)

  for (const line of appAddedGiftLines) {
    if (!desiredSet.has(line.variantId)) {
      remove.push({ id: line.id, variantId: line.variantId }); // undesired (e.g. previous tier)
      continue;
    }
    // A charged gift (finalLinePrice > 0) is always wrong — remove it. A $0 copy of the same
    // variant later in the list (or a re-add on the next pass) will replace it.
    if ((line.finalLinePrice ?? 0) > 0) {
      remove.push({ id: line.id, variantId: line.variantId });
      continue;
    }
    if (kept.has(line.variantId)) {
      remove.push({ id: line.id, variantId: line.variantId }); // duplicate/split line of a desired gift
      continue;
    }
    kept.add(line.variantId);
    if (line.quantity !== 1) {
      adjust.push({ id: line.id, variantId: line.variantId, quantity: 1 }); // collapse a bumped qty
    }
  }

  const add = desired
    .filter((variantId) => !kept.has(variantId))
    .map((variantId) => ({
      variantId,
      quantity: 1 as const,
      properties: { [GIFT_LINE_PROPERTY]: '1' },
    }));

  return {
    add,
    remove,
    adjust,
    applyCode: result.status === 'gift' ? result.code : null,
    status: result.status,
    reason: result.status === 'no-gift' ? result.reason : null,
  };
}
