// Test-only in-memory fakes for the repository/gateway ports (not exported from the package).
import type { ScopedGiftDiscountInput } from '@free-gift-engine/shopify';
import type { Campaign, GiftCodeMapping, MintingKey, Shop } from '../domain.js';
import {
  DuplicateDiscountCodeError,
  UniqueKeyViolationError,
  type CampaignRepository,
  type GiftCodeMappingTable,
  type GiftVariantGateway,
  type InstalledShopInput,
  type NewCampaignInput,
  type OAuthTokenExchanger,
  type ShopRepository,
  type ShopifyDiscountGateway,
  type ValidatedGiftVariant,
} from '../ports.js';

const EPOCH = new Date(0);

function keyString(key: MintingKey): string {
  return [key.campaignId, key.tierId, key.resolvedGiftSetHash, key.configVersionHash].join('|');
}

// In-memory GiftCodeMappingTable. insertPending performs a SYNCHRONOUS check-then-set so that two
// interleaved getOrCreate calls race exactly as the unique DB constraint would: one wins, the
// other gets UniqueKeyViolationError. createdAt is stamped from an injectable clock so tests can
// make a reservation look fresh (default) or abandoned (see seedAbandonedPending).
export class FakeMappingTable implements GiftCodeMappingTable {
  private readonly byKey = new Map<string, GiftCodeMapping>();
  private seq = 0;
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  findByKey(key: MintingKey): Promise<GiftCodeMapping | null> {
    return Promise.resolve(this.byKey.get(keyString(key)) ?? null);
  }

  insertPending(key: MintingKey): Promise<GiftCodeMapping> {
    const k = keyString(key);
    if (this.byKey.has(k)) {
      return Promise.reject(new UniqueKeyViolationError());
    }
    this.seq += 1;
    const row: GiftCodeMapping = {
      id: `m${this.seq}`,
      ...key,
      code: null,
      discountId: null,
      active: true,
      createdAt: this.now(),
    };
    this.byKey.set(k, row);
    return Promise.resolve(row);
  }

  // Inject a dangling reservation whose holder never resolved it (e.g. a zombie from a killed
  // serverless invocation), stamped with an OLD createdAt so the store treats it as abandoned.
  seedAbandonedPending(key: MintingKey, createdAt: Date = EPOCH): GiftCodeMapping {
    this.seq += 1;
    const row: GiftCodeMapping = {
      id: `m${this.seq}`,
      ...key,
      code: null,
      discountId: null,
      active: true,
      createdAt,
    };
    this.byKey.set(keyString(key), row);
    return row;
  }

  // Inject a SUPERSEDED row: a populated, but DEACTIVATED (active=false) code occupying this exact
  // key. It can't be reused (inactive) and blocks insertPending (unique key) — the live wedge. Recent
  // createdAt on purpose: an inactive row must be reclaimable regardless of age.
  seedSupersededCode(key: MintingKey, code: string): GiftCodeMapping {
    this.seq += 1;
    const row: GiftCodeMapping = {
      id: `m${this.seq}`,
      ...key,
      code,
      discountId: `disc-${code}`,
      active: false,
      createdAt: this.now(),
    };
    this.byKey.set(keyString(key), row);
    return row;
  }

  finalize(id: string, fields: { code: string; discountId: string }): Promise<GiftCodeMapping> {
    const row = this.rowById(id);
    const updated: GiftCodeMapping = { ...row, code: fields.code, discountId: fields.discountId };
    this.byKey.set(keyString(updated), updated);
    return Promise.resolve(updated);
  }

  deletePending(id: string): Promise<void> {
    const row = this.rowById(id);
    this.byKey.delete(keyString(row));
    return Promise.resolve();
  }

  findActiveByCampaign(campaignId: string): Promise<readonly GiftCodeMapping[]> {
    return Promise.resolve(
      [...this.byKey.values()].filter((r) => r.campaignId === campaignId && r.active),
    );
  }

  findActiveByShop(): Promise<readonly GiftCodeMapping[]> {
    return Promise.resolve([...this.byKey.values()].filter((r) => r.active));
  }

  markInactive(id: string): Promise<void> {
    const row = this.rowById(id);
    this.byKey.set(keyString(row), { ...row, active: false });
    return Promise.resolve();
  }

  private rowById(id: string): GiftCodeMapping {
    const row = [...this.byKey.values()].find((r) => r.id === id);
    if (row === undefined) {
      throw new Error(`FakeMappingTable: no row ${id}`);
    }
    return row;
  }
}

export class FakeDiscountGateway implements ShopifyDiscountGateway {
  createCount = 0;
  readonly deactivated: string[] = [];
  private duplicatesRemaining: number;
  private readonly failWith: Error | null;

  // failWith: every mint rejects with this error (models a hard mint failure such as an empty
  // qualifying scope). duplicateFirst: the first N mints reject as duplicate-code collisions.
  constructor(options: { duplicateFirst?: number; failWith?: Error } = {}) {
    this.duplicatesRemaining = options.duplicateFirst ?? 0;
    this.failWith = options.failWith ?? null;
  }

  createScopedGiftDiscount(
    input: ScopedGiftDiscountInput,
  ): Promise<{ code: string; discountId: string }> {
    this.createCount += 1;
    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }
    if (this.duplicatesRemaining > 0) {
      this.duplicatesRemaining -= 1;
      return Promise.reject(new DuplicateDiscountCodeError(input.code));
    }
    return Promise.resolve({ code: input.code, discountId: `disc-${input.code}` });
  }

  deactivateDiscount(discountId: string): Promise<void> {
    this.deactivated.push(discountId);
    return Promise.resolve();
  }
}

export class FakeVariantGateway implements GiftVariantGateway {
  constructor(private readonly deadIds: readonly string[] = []) {}

  fetch(variantIds: readonly string[]): Promise<readonly ValidatedGiftVariant[]> {
    const dead = variantIds.filter((id) => this.deadIds.includes(id));
    if (dead.length > 0) {
      return Promise.reject(new Error(`dead variants: ${dead.join(',')}`));
    }
    return Promise.resolve(
      variantIds.map((id) => ({ id, title: `Variant ${id}`, availableForSale: true })),
    );
  }
}

// Captures create/update inputs and materializes a Campaign so service behaviour is assertable.
export class FakeCampaignRepository implements CampaignRepository {
  readonly created: { shopId: string; input: NewCampaignInput }[] = [];
  private readonly store = new Map<string, Campaign>();
  private seq = 0;

  create(shopId: string, input: NewCampaignInput): Promise<Campaign> {
    this.created.push({ shopId, input });
    this.seq += 1;
    const campaign = this.materialize(`c${this.seq}`, shopId, input);
    this.store.set(campaign.id, campaign);
    return Promise.resolve(campaign);
  }

  update(id: string, input: NewCampaignInput): Promise<Campaign> {
    const existing = this.store.get(id);
    const shopId = existing?.shopId ?? 'shop';
    const campaign = this.materialize(id, shopId, input);
    this.store.set(id, campaign);
    return Promise.resolve(campaign);
  }

  findById(id: string): Promise<Campaign | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  listByShop(shopId: string): Promise<readonly Campaign[]> {
    return Promise.resolve([...this.store.values()].filter((c) => c.shopId === shopId));
  }

  updateConfigVersionHash(id: string, configVersionHash: string): Promise<void> {
    const existing = this.store.get(id);
    if (existing !== undefined) {
      this.store.set(id, { ...existing, configVersionHash });
    }
    return Promise.resolve();
  }

  private materialize(id: string, shopId: string, input: NewCampaignInput): Campaign {
    return {
      id,
      shopId,
      name: input.name,
      suppression: input.suppression,
      declineEnabled: input.declineEnabled,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      displayTimezone: input.displayTimezone,
      active: false,
      configVersionHash: input.configVersionHash,
      tiers: input.tiers.map((tier, index) => ({
        id: `${id}-t${index}`,
        campaignId: id,
        position: tier.position,
        baseThreshold: tier.baseThreshold,
        gift: tier.gift,
        marketThresholds: tier.marketThresholds.map((m, mIndex) => ({
          id: `${id}-t${index}-m${mIndex}`,
          tierId: `${id}-t${index}`,
          market: m.market,
          presentmentCurrency: m.presentmentCurrency,
          manualFxRate: m.manualFxRate,
          roundingRule: m.roundingRule,
          resolvedThreshold: m.resolvedThreshold,
        })),
      })),
    };
  }
}

export class FakeShopRepository implements ShopRepository {
  readonly upserts: InstalledShopInput[] = [];
  readonly uninstalled: string[] = [];
  private shop: Shop | null = null;

  seedInstalled(shop: Shop): void {
    this.shop = shop;
  }

  upsertInstalled(input: InstalledShopInput): Promise<Shop> {
    this.upserts.push(input);
    this.shop = {
      id: 's1',
      domain: input.domain,
      encryptedAccessToken: input.encryptedAccessToken,
      scopes: input.scopes,
      installedAt: EPOCH,
      uninstalledAt: null,
    };
    return Promise.resolve(this.shop);
  }

  findByDomain(domain: string): Promise<Shop | null> {
    return Promise.resolve(this.shop !== null && this.shop.domain === domain ? this.shop : null);
  }

  markUninstalled(domain: string): Promise<void> {
    this.uninstalled.push(domain);
    if (this.shop !== null) {
      this.shop = { ...this.shop, uninstalledAt: EPOCH };
    }
    return Promise.resolve();
  }
}

export class FakeTokenExchanger implements OAuthTokenExchanger {
  constructor(
    private readonly token = 'shpat_offline_token',
    private readonly scopes = 'read_products,write_discounts',
  ) {}

  exchange(): Promise<{ accessToken: string; scopes: string }> {
    return Promise.resolve({ accessToken: this.token, scopes: this.scopes });
  }
}
