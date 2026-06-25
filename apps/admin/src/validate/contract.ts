// FROZEN /validate CONTRACT — the request/response shapes the Phase 5 theme extension posts and
// consumes. JSON-serializable. The storefront uses `awards[].giftVariantIds` to reconcile gift
// lines and `awards[].code` to apply via /discount/CODE, then proceeds to the NATIVE checkout.
// /validate never mutates the cart.
//
// Server-authoritative: the client may supply ONLY the cart (variant + qty + an app-added claim),
// the OR choices, the decline flag, and a claimed presentment currency/country. Prices, isGift, and
// the qualifying tier are all recomputed server-side and never taken from the request.
import type { Money } from '@free-gift-engine/core';

export type ValidateCartLineInput = {
  readonly variantId: string;
  readonly quantity: number;
  // The storefront's claim that THIS line was auto-added by our app as a gift (it sets a
  // line-item property). Re-validated: a line is excluded from the qualifying subtotal only if
  // `appAdded` AND its variant is in the active campaign's gift-variant set. A separately
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
    };

export type ValidateErrorCode = 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'RATE_LIMITED';

export type ValidateError = {
  readonly error: {
    readonly code: ValidateErrorCode;
    readonly message: string;
  };
};
