// Persisted domain models for the admin data layer. Business rules live in @free-gift-engine/core;
// these are the shapes the repositories read/write. Money/GiftConfig/SuppressionMode are reused
// from core so the same types flow into core's hashing and resolution.
import type { GiftConfig, Money, SuppressionMode } from '@free-gift-engine/core';

export type Shop = {
  readonly id: string;
  readonly domain: string;
  // AES-256-GCM ciphertext of the offline Admin API token. Never stored in plaintext.
  readonly encryptedAccessToken: string;
  readonly scopes: string;
  readonly installedAt: Date;
  readonly uninstalledAt: Date | null;
};

export type MarketThreshold = {
  readonly id: string;
  readonly tierId: string;
  // Market handle/id (e.g. a Shopify Market) and its presentment currency.
  readonly market: string;
  readonly presentmentCurrency: string;
  // Manual FX from base -> presentment, or null when the admin enters a resolved amount directly.
  readonly manualFxRate: number | null;
  readonly roundingRule: RoundingRule;
  // The threshold actually used by BOTH the storefront widget and /validate (presentment currency).
  readonly resolvedThreshold: Money;
};

export type RoundingRule = 'none' | 'up-to-nearest-minor-100' | 'up-to-nearest-major';

export type Tier = {
  readonly id: string;
  readonly campaignId: string;
  readonly position: number;
  // Base-currency threshold (shop base currency). Per-market thresholds live in marketThresholds.
  readonly baseThreshold: Money;
  readonly gift: GiftConfig;
  readonly marketThresholds: readonly MarketThreshold[];
};

export type Campaign = {
  readonly id: string;
  readonly shopId: string;
  readonly name: string;
  readonly suppression: SuppressionMode;
  readonly declineEnabled: boolean;
  // Absolute UTC instants; displayTimezone is the admin's IANA zone for rendering only —
  // comparisons are always on the UTC instants (CLAUDE.md schedule decision).
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly displayTimezone: string;
  readonly active: boolean;
  readonly configVersionHash: string;
  // Merchant-configured qualifying collection GID. The collection defines which products count
  // toward the tier-qualifying subtotal and is the BXGY customerBuys scope. null when not yet set.
  readonly qualifyingCollectionId: string | null;
  readonly tiers: readonly Tier[];
};

// The reusable-code key (CLAUDE.md). UNIQUE in the database. The tier component is the tier POSITION
// (config-derived + stable across tier-row recreation), NOT the DB tier id — so the key is derivable
// from the campaign config before any DB write (enables eager-mint-before-commit for supersede) and an
// edit that recreates tier rows reuses the same code when the scope is unchanged. configVersionHash is
// the version discriminator: a scope change mints fresh codes under the new hash.
export type MintingKey = {
  readonly campaignId: string;
  readonly tierPosition: number;
  readonly resolvedGiftSetHash: string;
  readonly configVersionHash: string;
};

export type GiftCodeMapping = MintingKey & {
  readonly id: string;
  // null while the row is reserved but the Shopify discount has not been minted yet.
  readonly code: string | null;
  readonly discountId: string | null;
  readonly active: boolean;
  readonly createdAt: Date;
};
