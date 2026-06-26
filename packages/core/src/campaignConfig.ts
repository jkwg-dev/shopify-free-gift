// READ-ONLY campaign-config contract for the storefront perception UI (Phase 5b-2). Served by a
// SEPARATE App Proxy GET endpoint (GET /apps/free-gift/config) — NOT part of the frozen /validate
// wire contract (validate.ts), which is untouched. Lives in core because both layers depend inward
// on core (admin/theme -> core); JSON-serializable.
//
// /validate returns the RESULT for one cart; this returns the static STRUCTURE the widget renders
// from: every tier's enforced threshold and its gift options (grouped/disabled client-side). The
// chooser's selection still flows back through the EXISTING ValidateRequest.choices shape — only the
// SOURCE changes (user selection instead of the retired default_choices seam).
import type { Money } from './money.js';

// One selectable VARIANT in an OR tier, enriched server-side for rendering. The reconciler keys on
// `variantId` and never dedups by product; `productId` is for grouping sibling variants in the UI
// only (Ice/Dawn, S/M/L), never to merge options. `available` (server-derived via contextualPricing)
// disables an out-of-stock option — /validate's `gift-unavailable` remains the authoritative backstop.
export type GiftOptionView = {
  // The OR option id used as the /validate `choices` value (e.g. 'a', 'opt-3').
  readonly optionId: string;
  readonly variantId: string;
  readonly productId: string;
  // The OWNING PRODUCT's title — the heading for a product card that groups sibling variants (the
  // chooser shows ONE card per product with a variant picker inside). `variantLabel` is the variant's
  // own option value (Ice/Dawn, S/M/L). For a single-variant product the two coincide.
  readonly productLabel?: string;
  readonly variantLabel: string;
  readonly available: boolean;
  // Variant (or product) featured image for the chooser cards; null when the product has no image.
  // Optional in the type (older callers/fixtures may omit), but ALWAYS populated by the config builder.
  readonly imageUrl?: string | null;
};

// One variant of an AND tier (all unlocked together): same as an option minus the choice id.
export type GiftItemView = Omit<GiftOptionView, 'optionId'>;

export type TierConfig = {
  readonly tierId: string;
  readonly position: number;
  // The threshold ENFORCED for this market, in presentment currency — the SAME figure /validate
  // returns as `appliedThreshold`, so the widget's "Spend $X more" equals what the discount enforces.
  readonly threshold: Money;
  readonly gift:
    | { readonly kind: 'AND'; readonly gifts: readonly GiftItemView[] }
    | { readonly kind: 'OR'; readonly options: readonly GiftOptionView[] };
};

// The structure the widget renders, or `inactive` (no live campaign, or not sold in this market).
export type CampaignConfigResponse =
  | { readonly status: 'inactive' }
  | {
      readonly status: 'active';
      readonly currency: string;
      readonly declineEnabled: boolean;
      readonly tiers: readonly TierConfig[];
    };

// Market identifiers the GET endpoint reads from its (signed) query string — not sensitive, and
// re-validated server-side exactly like /validate's claimed currency/country.
export type CampaignConfigRequest = {
  readonly presentmentCurrency: string;
  readonly countryCode: string;
};
