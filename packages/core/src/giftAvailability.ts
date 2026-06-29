// Is a gift variant OFFERABLE right now? The SINGLE source of truth for that decision, shared by the
// storefront /config builder (what the chooser shows) and the admin greying endpoint — so the two
// surfaces can never disagree. Pure: it combines already-fetched signals, it does no I/O.
//
// "Available" spans THREE independent signals that can diverge (CLAUDE.md): priced in the market,
// PUBLISHED to the Online Store, and IN STOCK. availableForSale alone reflects stock/sellability, NOT
// channel publication — an in-stock-but-unpublished gift reads availableForSale:true yet 422s at
// /cart/add.js. So publication is its own signal here, not folded into stock.

export type GiftUnavailableReason =
  | 'unresolved' // the variant no longer resolves to a live ProductVariant (deleted)
  | 'unpriced' // no contextual price in this market (only meaningful with a market context)
  | 'not-published' // the owning product is not published to the Online Store publication
  | 'out-of-stock'; // availableForSale === false

export type GiftAvailability =
  | { readonly offerable: true; readonly reason: null }
  | { readonly offerable: false; readonly reason: GiftUnavailableReason };

export type GiftAvailabilitySignals = {
  // The variant resolved to a live product (metadata present).
  readonly resolved: boolean;
  // Present ONLY when evaluated with a market context (the storefront). OMIT for the market-agnostic
  // admin greying — `unpriced` is then never the reason. `false` means resolved-but-not-priced.
  readonly priced?: boolean;
  readonly publishedToOnlineStore: boolean;
  readonly inStock: boolean; // = ProductVariant.availableForSale
};

// Offerable iff resolved AND (priced, when a market context is supplied) AND published AND in stock.
// The reason names the FIRST failing signal, ordered most-fundamental first so the merchant/log sees
// the root cause (a deleted variant is reported as unresolved, not "out of stock").
export function giftOfferability(signals: GiftAvailabilitySignals): GiftAvailability {
  if (!signals.resolved) {
    return { offerable: false, reason: 'unresolved' };
  }
  if (signals.priced === false) {
    return { offerable: false, reason: 'unpriced' };
  }
  if (!signals.publishedToOnlineStore) {
    return { offerable: false, reason: 'not-published' };
  }
  if (!signals.inStock) {
    return { offerable: false, reason: 'out-of-stock' };
  }
  return { offerable: true, reason: null };
}
