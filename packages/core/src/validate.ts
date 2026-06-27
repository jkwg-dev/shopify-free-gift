// FROZEN /validate WIRE CONTRACT — the request/response shapes shared by the server (/validate
// route in apps/admin) and the storefront client (extensions/theme). Lives in core because both
// layers depend inward on core (admin/theme -> core); neither imports the other. JSON-serializable.
//
// Server-authoritative: the client may supply ONLY the cart (variant + qty + an app-added claim),
// the OR choices, the decline flag, and a claimed presentment currency/country. Prices, isGift, and
// the qualifying tier are all recomputed server-side and never taken from the request.
import type { Money } from './money.js';

export type ValidateCartLineInput = {
  readonly variantId: string;
  readonly quantity: number;
  // The storefront's claim that THIS line was auto-added by our app as a gift (it sets a
  // line-item property). Re-validated server-side: a line is excluded from the qualifying subtotal
  // only if `appAdded` AND its variant is in the active campaign's gift-variant set. A separately
  // purchased unit of a gift-eligible product (appAdded=false) still counts — exclusion is
  // per-line, not per-variant.
  readonly appAdded: boolean;
};

export type ValidateRequest = {
  readonly cart: readonly ValidateCartLineInput[];
  // Per-tier OR selections (tierId -> option id). Required for any active OR tier; an unknown or
  // missing choice is rejected (no silent default), so we never mint a code for an unpicked gift.
  readonly choices: Readonly<Record<string, string>>;
  // The shopper unchecked "Add my free gift" — resolves to no gift, no code.
  readonly declined: boolean;
  // Buyer's presentment currency + ISO country, from the cart/storefront. CLAIMED: the currency is
  // validated against the resolved market; the country drives authoritative presentment pricing.
  readonly presentmentCurrency: string;
  readonly countryCode: string;
  // Shopify's market FX rate (base -> presentment), from window.Shopify.currency.rate, as a decimal
  // STRING (preserve Shopify's precision). Additive + OPTIONAL. The server derives each tier's
  // presentment threshold = ceil(baseThreshold x rate) — the SAME rate Shopify uses for the BXGY
  // minimum, so display == enforced. CLAIMED but harmless: it only scales the displayed/compared
  // threshold, never the server-priced cart or the CAD discount floor, so a spoofed rate is a
  // self-inflicted UX glitch, never a leak. Absent/invalid in a non-base market => no gift there.
  readonly presentmentRate?: string;
};

// A qualifying result yields EXACTLY ONE reusable code (only 'highest-only' suppression is
// supported on Advanced — see CLAUDE.md). The code covers the winning tier's resolved gift
// variant(s): an AND tier is multiple variants under this one code, applied via a single
// /discount/CODE; an OR tier is the single chosen variant. The storefront uses `giftVariantIds`
// to reconcile cart lines and `code` to apply the discount, then proceeds to the native checkout.
export type ValidateResult =
  | {
      readonly status: 'gift';
      readonly currency: string;
      readonly subtotal: Money;
      readonly tierId: string;
      readonly giftVariantIds: readonly string[];
      // Reusable, variant-scoped, 100%-off code applied via /discount/CODE.
      readonly code: string;
      // The threshold actually enforced in this market, in presentment currency — equals the
      // widget's "Spend X to unlock" figure (the storefront invariant). The discount's own
      // base-currency minimum is the authoritative checkout backstop.
      readonly appliedThreshold: Money;
    }
  | {
      readonly status: 'no-gift';
      // 'cumulative-unsupported': core resolved more than one tier's gift-set. Cumulative cannot
      // be redeemed on Advanced (non-combinable codes + a single /discount/CODE), so /validate
      // refuses rather than hand out multiple unusable codes. The admin must not create it.
      readonly reason:
        | 'declined'
        | 'below-threshold'
        | 'inactive'
        | 'gift-unavailable'
        | 'cumulative-unsupported';
      // The server-computed qualifying subtotal (gift-excluded, presentment currency) WHEN it was
      // computed — present for every reason except 'inactive' (no cart context). Additive: lets the
      // stepper fill show real progress below tier 1 too; never used for eligibility (that's the gift
      // arm + the discount's checkout minimum).
      readonly subtotal?: Money;
    };

export type ValidateNoGiftReason = Extract<ValidateResult, { status: 'no-gift' }>['reason'];

export type ValidateErrorCode = 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'RATE_LIMITED';

export type ValidateError = {
  readonly error: {
    readonly code: ValidateErrorCode;
    readonly message: string;
  };
};
