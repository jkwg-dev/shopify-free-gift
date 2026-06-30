// Wire shapes for the Phase 3b campaign editor (Stage B). These are SEPARATE from the frozen
// contract.ts DTOs: the editor speaks human-friendly DECIMAL amount strings (e.g. "50.00"), while
// the contract (and the 3a service) speak integer minor units (Money). The route maps between them
// via editorMapping.ts, which applies the currency exponent at the packages/shopify boundary — so
// the browser never does currency math and a JPY threshold is never off by 100x. This module is
// pure types only (no value imports), so the client can `import type` it without pulling server code.
import type { SuppressionMode } from '@free-gift-engine/core';
import type { RoundingRule } from '../domain.js';

export type GiftKind = 'AND' | 'OR';

// One picked gift variant. `title` is display-only (from the resource picker / variant metadata) and
// is NOT persisted — the stored GiftConfig holds only variant ids. For an OR tier each entry is an
// option; for an AND tier each entry is a bundled gift.
export type EditorGiftVariant = {
  readonly variantId: string;
  readonly title: string;
};

export type EditorMarketThreshold = {
  readonly market: string;
  readonly presentmentCurrency: string;
  readonly amount: string; // decimal major units in presentmentCurrency
  readonly manualFxRate: string | null; // decimal string, or null when an amount is entered directly
  readonly roundingRule: RoundingRule;
};

export type EditorTier = {
  readonly position: number;
  readonly thresholdAmount: string; // decimal major units in thresholdCurrency (base currency)
  readonly thresholdCurrency: string;
  readonly giftKind: GiftKind;
  readonly gifts: readonly EditorGiftVariant[];
  readonly marketThresholds: readonly EditorMarketThreshold[];
};

// What the form POSTs/PUTs. suppression is always 'highest-only' from the UI (cumulative is not
// offerable on Advanced); the server re-checks it defensively.
export type CampaignEditorInput = {
  readonly name: string;
  readonly startsAt: string; // ISO 8601 UTC instant
  readonly endsAt: string;
  readonly declineEnabled: boolean;
  readonly suppression: SuppressionMode;
  // Merchant-configured qualifying collection GID. The collection defines which products count
  // toward the tier-qualifying subtotal. Required for activation.
  readonly qualifyingCollectionId?: string | null;
  readonly tiers: readonly EditorTier[];
};

// What GET /api/admin/campaigns/[id] returns for the editor: the input shape plus identity + state.
export type CampaignEditorView = CampaignEditorInput & {
  readonly id: string;
  readonly active: boolean;
  readonly qualifyingCollectionTitle?: string | null;
};
