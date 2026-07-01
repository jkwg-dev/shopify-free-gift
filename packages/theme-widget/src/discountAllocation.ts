// A single per-line discount entry as read from /cart.js (`items[].discounts`).
export type LineDiscount = { readonly amount?: number };

// Whether a cart line is ACTUALLY discounted (its price is reduced), for the purpose of excluding
// it from the qualifying subtotal (/validate treats a discounted line as full-price-only ineligible).
//
// A BXGY "customerGets" code (our free-gift code) stamps a $0 (`amount: 0`) "entitled" allocation on
// the full-price BUY lines too — not just the reduced gift (get) line. Counting that $0 entitlement
// as a real discount would exclude the very products that qualify the tier, collapsing the subtotal
// to ~0 → /validate returns no-gift → the gift + code are torn down on every cart change (then re-added
// once the code/allocation is gone, since the allocation disappears with the code) — an oscillation.
// Only an allocation that reduces the price (amount > 0) counts (e.g. a real Kite BOGO reduction).
export function lineHasRealDiscount(discounts: readonly LineDiscount[] | undefined): boolean {
  return (discounts ?? []).some((d) => (d.amount ?? 0) > 0);
}
