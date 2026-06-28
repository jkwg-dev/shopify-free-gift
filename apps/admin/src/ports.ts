// Repository and gateway interfaces (dependency inversion, CLAUDE.md). The store, services, and
// handlers depend ONLY on these ports; Prisma and the Shopify package are outer adapters injected
// at the composition root. This keeps the dangerous logic (concurrency, supersede) unit-testable
// with fakes and free of I/O.
import type { ScopedGiftDiscountInput } from '@free-gift-engine/shopify';
import type { Campaign, GiftCodeMapping, MintingKey, Shop, Tier } from './domain.js';

// --- Shop ---------------------------------------------------------------------------------------

export type InstalledShopInput = {
  readonly domain: string;
  readonly encryptedAccessToken: string;
  readonly scopes: string;
};

export interface ShopRepository {
  upsertInstalled(input: InstalledShopInput): Promise<Shop>;
  findByDomain(domain: string): Promise<Shop | null>;
  markUninstalled(domain: string): Promise<void>;
}

// --- Campaign -----------------------------------------------------------------------------------

export type NewTierInput = Omit<Tier, 'id' | 'campaignId' | 'marketThresholds'> & {
  readonly marketThresholds: readonly Omit<Tier['marketThresholds'][number], 'id' | 'tierId'>[];
};

export type NewCampaignInput = Omit<
  Campaign,
  'id' | 'shopId' | 'active' | 'configVersionHash' | 'tiers'
> & {
  readonly configVersionHash: string;
  readonly tiers: readonly NewTierInput[];
};

export interface CampaignRepository {
  create(shopId: string, input: NewCampaignInput): Promise<Campaign>;
  update(id: string, input: NewCampaignInput): Promise<Campaign>;
  findById(id: string): Promise<Campaign | null>;
  listByShop(shopId: string): Promise<readonly Campaign[]>;
  updateConfigVersionHash(id: string, configVersionHash: string): Promise<void>;
  // Flip the activation boolean (Phase 3c). create/update never touch `active`; this is the only
  // supported activation path. Used for plain deactivate.
  setActive(id: string, active: boolean): Promise<void>;
  // The single active FGE campaign for a shop (or null). Used to enforce mutual exclusion at activate.
  findActiveByShop(shopId: string): Promise<Campaign | null>;
  // ATOMIC swap (Phase 3c C3): in ONE transaction, deactivate every other active campaign for the
  // shop and activate `newActiveId` (also persisting its start instant for "start now"). Enforces
  // ≤ 1 active at the DB level — the swap is never observable as 0-active or 2-active.
  setActiveExclusive(shopId: string, newActiveId: string, startsAt: Date): Promise<void>;
}

// --- Gift-code mapping (low-level table the store arbitrates over) -------------------------------

// Thrown by insertPending when the unique key already exists. The store uses this to detect that
// another concurrent caller won the race, so it waits for and reuses that caller's code.
export class UniqueKeyViolationError extends Error {
  constructor() {
    super('Gift-code mapping key already reserved');
    this.name = 'UniqueKeyViolationError';
  }
}

export interface GiftCodeMappingTable {
  findByKey(key: MintingKey): Promise<GiftCodeMapping | null>;
  // Inserts a reservation row (code/discountId null). Throws UniqueKeyViolationError if the key
  // already exists — this is the concurrency arbiter.
  insertPending(key: MintingKey): Promise<GiftCodeMapping>;
  finalize(id: string, fields: { code: string; discountId: string }): Promise<GiftCodeMapping>;
  deletePending(id: string): Promise<void>;
  findActiveByCampaign(campaignId: string): Promise<readonly GiftCodeMapping[]>;
  findActiveByShop(shopId: string): Promise<readonly GiftCodeMapping[]>;
  markInactive(id: string): Promise<void>;
}

// --- Shopify gateways ---------------------------------------------------------------------------

// Thrown by the gateway adapter when Shopify rejects a create because the code already exists, so
// the store can regenerate and retry without depending on Shopify error-code strings.
export class DuplicateDiscountCodeError extends Error {
  constructor(readonly code: string) {
    super(`Discount code already exists: ${code}`);
    this.name = 'DuplicateDiscountCodeError';
  }
}

export interface ShopifyDiscountGateway {
  createScopedGiftDiscount(
    input: ScopedGiftDiscountInput,
  ): Promise<{ code: string; discountId: string }>;
  deactivateDiscount(discountId: string): Promise<void>;
  // Permanently delete the discount (Phase 3c teardown). After delete, a re-activation mints a FRESH
  // code under the same key — an expired/deactivated code can't be reused by the same-key dedup.
  deleteDiscount(discountId: string): Promise<void>;
}

export type ValidatedGiftVariant = {
  readonly id: string;
  readonly title: string;
  readonly availableForSale: boolean;
};

export interface GiftVariantGateway {
  // Resolves and validates variant GIDs; rejects (throws) if any id is not a live variant.
  fetch(variantIds: readonly string[]): Promise<readonly ValidatedGiftVariant[]>;
}

// Exchanges an OAuth authorization code for an offline access token (I/O against Shopify).
export interface OAuthTokenExchanger {
  exchange(shopDomain: string, code: string): Promise<{ accessToken: string; scopes: string }>;
}
