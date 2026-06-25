// A narrow structural view of the generated Prisma client — only the delegate methods the adapters
// use. The concrete `@prisma/client` (produced by `prisma generate` in an env with DATABASE_URL) is
// injected at the composition root, so this package typechecks and tests without the Prisma engine.
// Arg shapes are loosely typed at this I/O boundary; row shapes are concrete so adapters stay typed.

export type Args = Record<string, unknown>;

export interface PrismaDelegate<Row> {
  findUnique(args: { where: Args; include?: Args }): Promise<Row | null>;
  findMany(args: { where?: Args; include?: Args; orderBy?: Args }): Promise<Row[]>;
  create(args: { data: Args; include?: Args }): Promise<Row>;
  update(args: { where: Args; data: Args; include?: Args }): Promise<Row>;
  delete(args: { where: Args }): Promise<Row>;
  upsert(args: { where: Args; create: Args; update: Args; include?: Args }): Promise<Row>;
}

export type ShopRow = {
  id: string;
  domain: string;
  encryptedAccessToken: string;
  scopes: string;
  installedAt: Date;
  uninstalledAt: Date | null;
};

export type MarketThresholdRow = {
  id: string;
  tierId: string;
  market: string;
  presentmentCurrency: string;
  manualFxRate: number | null;
  roundingRule: string;
  resolvedThresholdAmount: number;
  resolvedThresholdCurrency: string;
};

export type TierRow = {
  id: string;
  campaignId: string;
  position: number;
  baseThresholdAmount: number;
  baseThresholdCurrency: string;
  giftConfig: unknown;
  marketThresholds: MarketThresholdRow[];
};

export type CampaignRow = {
  id: string;
  shopId: string;
  name: string;
  suppression: string;
  declineEnabled: boolean;
  startsAt: Date;
  endsAt: Date;
  displayTimezone: string;
  active: boolean;
  configVersionHash: string;
  tiers: TierRow[];
};

export type GiftCodeMappingRow = {
  id: string;
  campaignId: string;
  tierId: string;
  resolvedGiftSetHash: string;
  configVersionHash: string;
  code: string | null;
  discountId: string | null;
  active: boolean;
  createdAt: Date;
};

export interface PrismaLike {
  shop: PrismaDelegate<ShopRow>;
  campaign: PrismaDelegate<CampaignRow>;
  giftCodeMapping: PrismaDelegate<GiftCodeMappingRow>;
}

// Prisma raises P2002 on a unique-constraint violation.
export function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
