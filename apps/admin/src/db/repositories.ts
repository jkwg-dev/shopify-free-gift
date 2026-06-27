import { money, type GiftConfig } from '@free-gift-engine/core';
import type {
  Campaign,
  GiftCodeMapping,
  MarketThreshold,
  MintingKey,
  RoundingRule,
  Shop,
  Tier,
} from '../domain.js';
import {
  UniqueKeyViolationError,
  type CampaignRepository,
  type GiftCodeMappingTable,
  type InstalledShopInput,
  type NewCampaignInput,
  type ShopRepository,
} from '../ports.js';
import {
  isPrismaUniqueViolation,
  type CampaignRow,
  type GiftCodeMappingRow,
  type MarketThresholdRow,
  type PrismaLike,
  type ShopRow,
  type TierRow,
} from './prismaLike.js';

// Prisma adapters implementing the repository ports. The concrete PrismaClient is injected so the
// pure logic (store, services) stays DB-free and testable. All mapping between DB rows and domain
// models happens here, at the I/O edge.

const campaignInclude = { tiers: { include: { marketThresholds: true } } };

function toShop(row: ShopRow): Shop {
  return {
    id: row.id,
    domain: row.domain,
    encryptedAccessToken: row.encryptedAccessToken,
    scopes: row.scopes,
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt,
  };
}

function toMarketThreshold(row: MarketThresholdRow): MarketThreshold {
  return {
    id: row.id,
    tierId: row.tierId,
    market: row.market,
    presentmentCurrency: row.presentmentCurrency,
    manualFxRate: row.manualFxRate,
    roundingRule: row.roundingRule as RoundingRule,
    resolvedThreshold: money(row.resolvedThresholdAmount, row.resolvedThresholdCurrency),
  };
}

function toTier(row: TierRow): Tier {
  return {
    id: row.id,
    campaignId: row.campaignId,
    position: row.position,
    baseThreshold: money(row.baseThresholdAmount, row.baseThresholdCurrency),
    gift: row.giftConfig as GiftConfig,
    marketThresholds: row.marketThresholds.map(toMarketThreshold),
  };
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    shopId: row.shopId,
    name: row.name,
    suppression: row.suppression === 'cumulative' ? 'cumulative' : 'highest-only',
    declineEnabled: row.declineEnabled,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    displayTimezone: row.displayTimezone,
    active: row.active,
    configVersionHash: row.configVersionHash,
    tiers: [...row.tiers].sort((a, b) => a.position - b.position).map(toTier),
  };
}

function toMapping(row: GiftCodeMappingRow): GiftCodeMapping {
  return {
    id: row.id,
    campaignId: row.campaignId,
    tierId: row.tierId,
    resolvedGiftSetHash: row.resolvedGiftSetHash,
    configVersionHash: row.configVersionHash,
    code: row.code,
    discountId: row.discountId,
    active: row.active,
    createdAt: row.createdAt,
  };
}

function tierCreateData(input: NewCampaignInput['tiers'][number]): Record<string, unknown> {
  return {
    position: input.position,
    baseThresholdAmount: input.baseThreshold.amountMinor,
    baseThresholdCurrency: input.baseThreshold.currency,
    giftConfig: input.gift,
    marketThresholds: {
      create: input.marketThresholds.map((m) => ({
        market: m.market,
        presentmentCurrency: m.presentmentCurrency,
        manualFxRate: m.manualFxRate,
        roundingRule: m.roundingRule,
        resolvedThresholdAmount: m.resolvedThreshold.amountMinor,
        resolvedThresholdCurrency: m.resolvedThreshold.currency,
      })),
    },
  };
}

function campaignData(input: NewCampaignInput): Record<string, unknown> {
  return {
    name: input.name,
    suppression: input.suppression,
    declineEnabled: input.declineEnabled,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    displayTimezone: input.displayTimezone,
    configVersionHash: input.configVersionHash,
  };
}

export class PrismaShopRepository implements ShopRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async upsertInstalled(input: InstalledShopInput): Promise<Shop> {
    const row = await this.prisma.shop.upsert({
      where: { domain: input.domain },
      create: {
        domain: input.domain,
        encryptedAccessToken: input.encryptedAccessToken,
        scopes: input.scopes,
      },
      update: {
        encryptedAccessToken: input.encryptedAccessToken,
        scopes: input.scopes,
        uninstalledAt: null,
      },
    });
    return toShop(row);
  }

  async findByDomain(domain: string): Promise<Shop | null> {
    const row = await this.prisma.shop.findUnique({ where: { domain } });
    return row === null ? null : toShop(row);
  }

  async markUninstalled(domain: string): Promise<void> {
    await this.prisma.shop.update({ where: { domain }, data: { uninstalledAt: new Date() } });
  }
}

export class PrismaCampaignRepository implements CampaignRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async create(shopId: string, input: NewCampaignInput): Promise<Campaign> {
    const row = await this.prisma.campaign.create({
      data: {
        shopId,
        ...campaignData(input),
        tiers: { create: input.tiers.map(tierCreateData) },
      },
      include: campaignInclude,
    });
    return toCampaign(row);
  }

  async update(id: string, input: NewCampaignInput): Promise<Campaign> {
    // Replace tiers wholesale (cascade removes their market thresholds). Live discount codes are
    // never touched here — superseding is the caller's separate step.
    const row = await this.prisma.campaign.update({
      where: { id },
      data: {
        ...campaignData(input),
        tiers: { deleteMany: {}, create: input.tiers.map(tierCreateData) },
      },
      include: campaignInclude,
    });
    return toCampaign(row);
  }

  async findById(id: string): Promise<Campaign | null> {
    const row = await this.prisma.campaign.findUnique({ where: { id }, include: campaignInclude });
    return row === null ? null : toCampaign(row);
  }

  async listByShop(shopId: string): Promise<readonly Campaign[]> {
    const rows = await this.prisma.campaign.findMany({
      where: { shopId },
      include: campaignInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toCampaign);
  }

  async updateConfigVersionHash(id: string, configVersionHash: string): Promise<void> {
    await this.prisma.campaign.update({ where: { id }, data: { configVersionHash } });
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.prisma.campaign.update({ where: { id }, data: { active } });
  }

  async findActiveByShop(shopId: string): Promise<Campaign | null> {
    // The ≤ 1-active invariant means at most one row matches; take the first defensively.
    const rows = await this.prisma.campaign.findMany({
      where: { shopId, active: true },
      include: campaignInclude,
    });
    const row = rows[0];
    return row === undefined ? null : toCampaign(row);
  }
}

export class PrismaGiftCodeMappingTable implements GiftCodeMappingTable {
  constructor(private readonly prisma: PrismaLike) {}

  async findByKey(key: MintingKey): Promise<GiftCodeMapping | null> {
    const row = await this.prisma.giftCodeMapping.findUnique({ where: { minting_key: key } });
    return row === null ? null : toMapping(row);
  }

  async insertPending(key: MintingKey): Promise<GiftCodeMapping> {
    try {
      const row = await this.prisma.giftCodeMapping.create({ data: { ...key } });
      return toMapping(row);
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        throw new UniqueKeyViolationError();
      }
      throw err;
    }
  }

  async finalize(
    id: string,
    fields: { code: string; discountId: string },
  ): Promise<GiftCodeMapping> {
    const row = await this.prisma.giftCodeMapping.update({
      where: { id },
      data: { code: fields.code, discountId: fields.discountId },
    });
    return toMapping(row);
  }

  async deletePending(id: string): Promise<void> {
    await this.prisma.giftCodeMapping.delete({ where: { id } });
  }

  async findActiveByCampaign(campaignId: string): Promise<readonly GiftCodeMapping[]> {
    const rows = await this.prisma.giftCodeMapping.findMany({
      where: { campaignId, active: true },
    });
    return rows.map(toMapping);
  }

  async findActiveByShop(shopId: string): Promise<readonly GiftCodeMapping[]> {
    const rows = await this.prisma.giftCodeMapping.findMany({
      where: { active: true, campaign: { shopId } },
    });
    return rows.map(toMapping);
  }

  async markInactive(id: string): Promise<void> {
    await this.prisma.giftCodeMapping.update({ where: { id }, data: { active: false } });
  }
}
