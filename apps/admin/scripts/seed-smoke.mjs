// Smoke-test seed: creates ONE highest-only campaign directly in the dev database (no admin UI yet
// — that's Phase 3b). Mirrors the REAL storefront spec (the mockup is canonical). Idempotent:
// re-running replaces the shop's campaigns.
//
//   node apps/admin/scripts/seed-smoke.mjs
//
// Tiers (base currency USD), suppression = highest-only (only the highest qualifying tier's gift):
//   $500+   OR  -> choose one of {GFJ Socks, GFJ Arm Sleeves}
//   $1000+  AND -> both {GFJ Club Brush, GFJ G-Bear Tee Holder} under ONE code
//   $1500+  OR  -> choose one of EIGHT GFJ Hat variants
// Each tier also carries one CAD market threshold (manual FX) for the non-base-market step.
//
// Required env (every GID MUST be a real ProductVariant on the dev store):
//   DATABASE_URL / DIRECT_URL          the dev Postgres branch
//   SHOPIFY_SHOP_DOMAIN                e.g. our-dev-store.myshopify.com
//   SEED_OR500_SOCKS, SEED_OR500_SLEEVES                 tier $500 (OR)
//   SEED_AND1000_BRUSH, SEED_AND1000_TEEHOLDER           tier $1000 (AND)
//   SEED_HAT_GIDS                                        tier $1500 (OR) — comma-separated hat GIDs
//                                                        (eight per the spec; core OR handles any N)
// => 12 gift variant GIDs total (2 + 2 + 8).
//
// Tip: make at least one gift variant (e.g. SEED_OR500_SOCKS) also a normally purchasable catalog
// item so the runbook can exercise the paid-duplicate rule (a paid unit still counts toward the
// subtotal; only the app-added free unit is excluded).
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

// Manual FX for the one non-base market exercised by the runbook (USD base -> CAD presentment).
function cadThreshold(resolvedThresholdAmount) {
  return {
    create: [
      {
        market: 'CA',
        presentmentCurrency: 'CAD',
        manualFxRate: 1.4,
        roundingRule: 'none',
        resolvedThresholdAmount, // minor units, CAD
        resolvedThresholdCurrency: 'CAD',
      },
    ],
  };
}

async function main() {
  const domain = requireEnv('SHOPIFY_SHOP_DOMAIN');

  const socks = requireEnv('SEED_OR500_SOCKS');
  const sleeves = requireEnv('SEED_OR500_SLEEVES');
  const brush = requireEnv('SEED_AND1000_BRUSH');
  const teeHolder = requireEnv('SEED_AND1000_TEEHOLDER');
  const hats = requireEnv('SEED_HAT_GIDS')
    .split(',')
    .map((gid) => gid.trim())
    .filter((gid) => gid.length > 0);
  if (hats.length === 0) {
    throw new Error('SEED_HAT_GIDS must list at least one hat variant GID (comma-separated)');
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
      name: 'Smoke Test — GFJ Free Gift',
      suppression: 'highest-only',
      declineEnabled: true,
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2027-01-01T00:00:00Z'),
      displayTimezone: 'UTC',
      active: true,
      configVersionHash: 'seed-smoke-v2',
      tiers: {
        create: [
          {
            position: 1,
            baseThresholdAmount: 50000, // $500.00
            baseThresholdCurrency: 'USD',
            giftConfig: {
              kind: 'OR',
              options: [
                { id: 'socks', variantId: socks },
                { id: 'sleeves', variantId: sleeves },
              ],
            },
            marketThresholds: cadThreshold(70000), // CA$700.00
          },
          {
            position: 2,
            baseThresholdAmount: 100000, // $1000.00
            baseThresholdCurrency: 'USD',
            giftConfig: {
              kind: 'AND',
              gifts: [{ variantId: brush }, { variantId: teeHolder }],
            },
            marketThresholds: cadThreshold(140000), // CA$1400.00
          },
          {
            position: 3,
            baseThresholdAmount: 150000, // $1500.00
            baseThresholdCurrency: 'USD',
            giftConfig: {
              kind: 'OR',
              options: hats.map((variantId, i) => ({ id: `hat-${i + 1}`, variantId })),
            },
            marketThresholds: cadThreshold(210000), // CA$2100.00
          },
        ],
      },
    },
    include: { tiers: { include: { marketThresholds: true } } },
  });

  console.log(`Seeded campaign ${campaign.id} ("${campaign.name}") for shop ${domain}`);
  console.log(`  tier 1 (OR, $500):  socks=${socks}, sleeves=${sleeves}`);
  console.log(`  tier 2 (AND, $1000): brush=${brush}, teeHolder=${teeHolder}`);
  console.log(`  tier 3 (OR, $1500):  ${hats.length} hats -> ${hats.join(', ')}`);
  console.log('  active=true, suppression=highest-only, CAD market threshold per tier');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
