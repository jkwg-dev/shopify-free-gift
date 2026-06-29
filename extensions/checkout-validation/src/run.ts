// Cart & Checkout Validation Function — FGE free-gift checkout gate (Approach A; see
// docs/checkout-validation-function-design.md). Target: cart.validations.generate.run.
//
// RULE: a line carrying the app's `_fge_gift` marker MUST currently be free (its post-discount total
// == 0). If it is NOT free, the cart no longer qualifies for that gift and checkout is BLOCKED.
//
// Why this is correct AND multi-currency-safe: a gift line is $0 IFF the FGE BXGY discount applied,
// which happens IFF the cart met the discount's base-currency minimum (Shopify converts per market and
// drops the allocation the instant the qualifying subtotal falls below the tier minimum — empirically
// verified: tier-2 gifts revert to full price in /cart.js immediately). So "gift is free" == "cart
// qualifies", and we DEFER all threshold/tier/AND/FX logic to Shopify's own enforcement. There is NO
// FX recompute here, hence NO boundary mismatch and NO false block. This also runs on EXPRESS checkouts
// (Shop Pay / Apple Pay / etc.) where the storefront widget JS never runs — the only gate there.
//
// Self-contained by design: NO network, NO metafield, and no relative source imports (the Wasm bundle
// stays a single module). The pure decision is exported and unit-tested. The `_fge_gift` key matches
// packages/core GIFT_LINE_PROPERTY and the alias in run.graphql (both asserted in run.test.ts). Lines
// without the marker (normal paid items, Kite BOGO) are never touched.

export const GIFT_GATE_MESSAGE =
  'Your cart no longer qualifies for the free gift. Please update your cart.';

// Global cart-level target so the error renders at the top of cart/checkout (not tied to a field).
const CART_TARGET = '$.cart';

// The minimal per-line shape the rule needs, decoupled from the GraphQL input shape for testability.
export type GiftGateLine = {
  // The line carries the app's `_fge_gift` marker (an FGE-added gift line).
  readonly isFreeGiftLine: boolean;
  // The line's post-discount total, as Shopify's decimal string ("0.00" when granted, "729.95" once
  // the discount has reverted it to full price).
  readonly lineTotalAmount: string;
};

// Block IFF some FGE gift line is NOT currently free. Exact-zero semantics: a 100%-off gift line is
// exactly 0 in presentment currency, so any STRICTLY POSITIVE total means the discount no longer
// applies. A non-numeric/garbage amount parses to NaN (NaN > 0 === false) -> not blocked: fail-open
// per line, never block on data we can't read.
export function hasUnqualifiedGiftLine(lines: readonly GiftGateLine[]): boolean {
  return lines.some((line) => line.isFreeGiftLine && Number.parseFloat(line.lineTotalAmount) > 0);
}

// --- Shopify Function entry (cart.validations.generate.run) ---------------------------------------

type RunInput = {
  readonly cart: {
    readonly lines: ReadonlyArray<{
      readonly cost: { readonly totalAmount: { readonly amount: string } };
      // attribute(key:"_fge_gift") — null when the line has no such property (paid / Kite lines).
      readonly isFreeGift: { readonly value: string } | null;
    }>;
  };
};

type ValidationError = { readonly message: string; readonly target: string };
type FunctionRunResult = {
  readonly operations: ReadonlyArray<{
    readonly validationAdd: { readonly errors: readonly ValidationError[] };
  }>;
};

// No operation == no validation error added == checkout proceeds.
const ALLOW: FunctionRunResult = { operations: [] };

export function cartValidationsGenerateRun(input: RunInput): FunctionRunResult {
  const lines: GiftGateLine[] = input.cart.lines.map((line) => ({
    // Presence of the marker = an FGE gift line (mirrors the widget's GIFT_LINE_PROPERTY != null check).
    isFreeGiftLine: line.isFreeGift?.value != null,
    lineTotalAmount: line.cost.totalAmount.amount,
  }));
  if (!hasUnqualifiedGiftLine(lines)) {
    return ALLOW;
  }
  // One global error is enough; the message tells the shopper to fix the cart.
  return {
    operations: [
      { validationAdd: { errors: [{ message: GIFT_GATE_MESSAGE, target: CART_TARGET }] } },
    ],
  };
}
