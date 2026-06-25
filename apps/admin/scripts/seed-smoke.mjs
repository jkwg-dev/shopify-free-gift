// Smoke-test seed: creates ONE highest-only campaign directly in the dev database (no admin UI yet
// — that's Phase 3b). Idempotent: re-running replaces the shop's campaigns.
//
//   node apps/admin/scripts/seed-smoke.mjs
//
// Required env (the gift variant GIDs MUST be real variants on the dev store):
//   DATABASE_URL / DIRECT_URL   the dev Postgres branch
//   SHOPIFY_SHOP_DOMAIN         e.g. our-dev-store.myshopify.com
//   SEED_AND_VARIANT_1, SEED_AND_VARIANT_2   tier 1 (AND) gift variants -> both go free under ONE code
//   SEED_OR_VARIANT_A,  SEED_OR_VARIANT_B    tier 2 (OR) choices -> exactly the picked one goes free
//
// Tiers (base currency USD): tier 1 unlocks at $50, tier 2 at $100. Suppression is highest-only,
// so $50–$99 frees tier 1; >= $100 frees tier 2 and suppresses tier 1. One CAD market threshold
// (manual FX) is attached to each tier for the non-base-market step of the runbook.
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

async function main() {
  const domain = requireEnv('SHOPIFY_SHOP_DOMAIN');
  const and1 = requireEnv('SEED_AND_VARIANT_1');
  const and2 = requireEnv('SEED_AND_VARIANT_2');
  const orA = requireEnv('SEED_OR_VARIANT_A');
  const orB = requireEnv('SEED_OR_VARIANT_B');

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
      configVersionHash: 'seed-smoke-v1',
      tiers: {
        create: [
          {
            position: 1,
            baseThresholdAmount: 5000, // $50.00
            baseThresholdCurrency: 'USD',
            giftConfig: { kind: 'AND', gifts: [{ variantId: and1 }, { variantId: and2 }] },
            marketThresholds: {
              create: [
                {
                  market: 'CA',
                  presentmentCurrency: 'CAD',
                  manualFxRate: 1.4,
                  roundingRule: 'none',
                  resolvedThresholdAmount: 7000, // CA$70.00
                  resolvedThresholdCurrency: 'CAD',
                },
              ],
            },
          },
          {
            position: 2,
            baseThresholdAmount: 10000, // $100.00
            baseThresholdCurrency: 'USD',
            giftConfig: {
              kind: 'OR',
              options: [
                { id: 'a', variantId: orA },
                { id: 'b', variantId: orB },
              ],
            },
            marketThresholds: {
              create: [
                {
                  market: 'CA',
                  presentmentCurrency: 'CAD',
                  manualFxRate: 1.4,
                  roundingRule: 'none',
                  resolvedThresholdAmount: 14000, // CA$140.00
                  resolvedThresholdCurrency: 'CAD',
                },
              ],
            },
          },
        ],
      },
    },
    include: { tiers: { include: { marketThresholds: true } } },
  });

  console.log(`Seeded campaign ${campaign.id} ("${campaign.name}") for shop ${domain}`);
  console.log(`  tier 1 (AND, $50): ${and1}, ${and2}`);
  console.log(`  tier 2 (OR, $100): a=${orA}, b=${orB}`);
  console.log('  active=true, suppression=highest-only, CAD market threshold attached');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
