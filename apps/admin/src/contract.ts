// FROZEN API CONTRACT — the request/response shapes the Phase 3b Polaris UI consumes. These are
// JSON-serializable (dates as ISO 8601 strings); the handlers map them to/from the domain models.
// 3b builds against these and must not require reopening 3a.
import type { GiftConfig, Money, SuppressionMode } from '@free-gift-engine/core';
import type { RoundingRule } from './domain.js';

export type MarketThresholdDTO = {
  readonly market: string;
  readonly presentmentCurrency: string;
  readonly manualFxRate: number | null;
  readonly roundingRule: RoundingRule;
  readonly resolvedThreshold: Money;
};

export type TierDTO = {
  readonly position: number;
  readonly baseThreshold: Money;
  readonly gift: GiftConfig;
  readonly marketThresholds: readonly MarketThresholdDTO[];
};

export type TierResponseDTO = TierDTO & { readonly id: string };

export type CampaignInputDTO = {
  readonly name: string;
  readonly suppression: SuppressionMode;
  readonly declineEnabled: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly displayTimezone: string;
  // Merchant-configured qualifying collection GID (Shopify collection that defines which products
  // count toward the tier-qualifying subtotal). Required for activation; nullable for drafts.
  readonly qualifyingCollectionId?: string | null;
  readonly tiers: readonly TierDTO[];
};

export type CampaignDTO = {
  readonly id: string;
  readonly shopId: string;
  readonly name: string;
  readonly suppression: SuppressionMode;
  readonly declineEnabled: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly displayTimezone: string;
  readonly active: boolean;
  readonly configVersionHash: string;
  readonly qualifyingCollectionId: string | null;
  readonly tiers: readonly TierResponseDTO[];
};

export type CreateCampaignRequest = CampaignInputDTO;
export type UpdateCampaignRequest = CampaignInputDTO;
export type CampaignResponse = CampaignDTO;
export type ListCampaignsResponse = { readonly campaigns: readonly CampaignDTO[] };

export type ValidateVariantsRequest = { readonly variantIds: readonly string[] };
export type ValidateVariantsResponse = {
  readonly variants: readonly {
    readonly id: string;
    readonly title: string;
    readonly availableForSale: boolean;
  }[];
};

// Uniform error envelope. `invalid` lists offending ids (e.g. dead gift variants) when relevant.
// `requiresConfirmation` (Phase 3c) signals the client to show a confirm dialog and re-send with
// confirmReplace (activating a campaign that would replace the live one). Additive + optional.
export type ApiError = {
  readonly error: {
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'CONFIRM_REQUIRED';
    readonly message: string;
    readonly invalid?: readonly string[];
    readonly requiresConfirmation?: boolean;
  };
};
