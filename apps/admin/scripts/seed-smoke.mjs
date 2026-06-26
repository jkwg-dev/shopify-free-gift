// Smoke-test seed: creates ONE highest-only campaign directly in the dev database (no admin UI yet
// — that's Phase 3b). Mirrors the real storefront spec (2 / 2 / 8). Idempotent: re-running replaces
// the shop's campaigns.
//
//   node apps/admin/scripts/seed-smoke.mjs
//
// Tiers — BASE CURRENCY = CAD (this dev store's base), suppression = highest-only:
//   CA$500+   OR  -> choose one of two variants            (SEED_OR500_A, SEED_OR500_B)
//   CA$1000+  AND -> both variants under ONE code          (SEED_AND1000_A, SEED_AND1000_B)
//   CA$1500+  OR  -> choose one of N variants              (SEED_OR1500_GIDS, comma-separated)
// Each tier carries one NON-base market threshold (USD) with manual FX, for the presentment step.
//
// The seed is product-agnostic: it stores variant GIDs only (the engine keys on variant GID and has
// no productId). It does NOT hardcode product names and does NOT call Shopify — human-readable
// labels for the stand-in products live in docs/phase-4-smoke-test.md (and the Phase 3b admin will
// show real titles via packages/shopify when campaigns are built through the UI).
//
// Required env (every GID MUST be a real ProductVariant on the dev store):
//   DATABASE_URL / DIRECT_URL          the dev Postgres branch
//   SHOPIFY_SHOP_DOMAIN                e.g. our-dev-store.myshopify.com
//   SEED_OR500_A, SEED_OR500_B                          tier CA$500 (OR)
//   SEED_AND1000_A, SEED_AND1000_B                      tier CA$1000 (AND)
//   SEED_OR1500_GIDS                                    tier CA$1500 (OR) — comma-separated GIDs
//
// configVersionHash is a fixed seed marker — /validate only needs it to be STABLE (it keys the
// gift-code mapping). Real campaigns created via the Phase 3b admin compute it from config.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// One non-base market (USD) per tier, manual FX from the CAD base. Amounts are minor units, USD.
function usdMarketThreshold(resolvedThresholdAmount) {
  return {
    create: [
      {
        market: 'US',
        presentmentCurrency: 'USD',
        manualFxRate: 0.74, // CAD -> USD
        roundingRule: 'none',
        resolvedThresholdAmount,
        resolvedThresholdCurrency: 'USD',
      },
    ],
  };
}

async function main() {
  const domain = requireEnv('SHOPIFY_SHOP_DOMAIN');

  const or500a = requireEnv('SEED_OR500_A');
  const or500b = requireEnv('SEED_OR500_B');
  const and1000a = requireEnv('SEED_AND1000_A');
  const and1000b = requireEnv('SEED_AND1000_B');
  const or1500 = requireEnv('SEED_OR1500_GIDS')
    .split(',')
    .map((gid) => gid.trim())
    .filter((gid) => gid.length > 0);
  if (or1500.length === 0) {
    throw new Error('SEED_OR1500_GIDS must list at least one variant GID (comma-separated)');
  }

  // GUARD (5b-2a): a gift variant must NOT be the qualifying paid product. A variant that is both
  // qualifying AND a gift is internally contradictory (a correct gift is tagged app:fge_gift and
  // EXCLUDED from the qualifying collection, so it can't drive the threshold) and breaks the cart
  // (the widget adds it as a gift, colliding with the shopper's paid line). Pass the qualifying
  // variant GID(s) via SEED_QUALIFYING_GIDS (comma-separated) and we reject any overlap BEFORE
  // touching the DB. See docs/phase-5b-reseed.md.
  const qualifying = new Set(
    (process.env.SEED_QUALIFYING_GIDS ?? '')
      .split(',')
      .map((gid) => gid.trim())
      .filter((gid) => gid.length > 0),
  );
  const allGiftGids = [or500a, or500b, and1000a, and1000b, ...or1500];
  const collisions = [...new Set(allGiftGids.filter((gid) => qualifying.has(gid)))];
  if (collisions.length > 0) {
    throw new Error(
      `Gift/qualifying collision — these gift variants are also the qualifying product and must ` +
        `NOT be gifts: ${collisions.join(', ')}. Fix SEED_*_GIDS so gift variants are disjoint ` +
        `from SEED_QUALIFYING_GIDS.`,
    );
  }

  const shop = await prisma.shop.upsert({
    where: { domain },
    create: {
      domain,
      encryptedAccessToken: 'seed-placeholder',
      scopes: 'read_products,write_discounts',
    },
    update: {},
  });

  // Fresh start: drop existing campaigns for this shop (cascades tiers, thresholds, mappings).
  await prisma.campaign.deleteMany({ where: { shopId: shop.id } });

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: 'Smoke Test — Free Gift',
      suppression: 'highest-only',
      declineEnabled: true,
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2027-01-01T00:00:00Z'),
      displayTimezone: 'UTC',
      active: true,
      configVersionHash: 'seed-smoke-v3',
      tiers: {
        create: [
          {
            position: 1,
            baseThresholdAmount: 50000, // CA$500.00
            baseThresholdCurrency: 'CAD',
            giftConfig: {
              kind: 'OR',
              options: [
                { id: 'a', variantId: or500a },
                { id: 'b', variantId: or500b },
              ],
            },
            marketThresholds: usdMarketThreshold(37000), // US$370.00
          },
          {
            position: 2,
            baseThresholdAmount: 100000, // CA$1000.00
            baseThresholdCurrency: 'CAD',
            giftConfig: {
              kind: 'AND',
              gifts: [{ variantId: and1000a }, { variantId: and1000b }],
            },
            marketThresholds: usdMarketThreshold(74000), // US$740.00
          },
          {
            position: 3,
            baseThresholdAmount: 150000, // CA$1500.00
            baseThresholdCurrency: 'CAD',
            giftConfig: {
              kind: 'OR',
              options: or1500.map((variantId, i) => ({ id: `opt-${i + 1}`, variantId })),
            },
            marketThresholds: usdMarketThreshold(111000), // US$1110.00
          },
        ],
      },
    },
    include: { tiers: { include: { marketThresholds: true } } },
  });

  const tierId = (position) => campaign.tiers.find((t) => t.position === position)?.id;

  console.log(`Seeded campaign ${campaign.id} ("${campaign.name}") for shop ${domain}`);
  console.log(`  base currency CAD; non-base market USD (manual FX); suppression=highest-only`);
  console.log(`  tier 1 (OR, CA$500)   id=${tierId(1)}  a=${or500a}  b=${or500b}`);
  console.log(`  tier 2 (AND, CA$1000) id=${tierId(2)}  ${and1000a}  ${and1000b}`);
  console.log(
    `  tier 3 (OR, CA$1500)  id=${tierId(3)}  ${or1500.length} options (opt-1..opt-${or1500.length})`,
  );
  or1500.forEach((gid, i) => console.log(`    opt-${i + 1} = ${gid}`));
  console.log(
    `\nUse the tier id as the "choices" key for OR tiers, e.g. {"${tierId(1)}":"a"} picks tier-1 option a.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
