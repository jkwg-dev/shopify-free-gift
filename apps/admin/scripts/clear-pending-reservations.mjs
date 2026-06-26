// Clear gift-code mapping rows that WEDGE a minting key for a shop. Two unusable states:
//   (1) zombie RESERVATION  — code IS NULL, holder died mid-mint (killed serverless invocation);
//   (2) superseded ROW      — active = false, a deactivated code still occupying its key. getOrCreate
//       can't reuse it (inactive) yet insertPending hits the unique key, so it timed out every call.
//
//   SHOPIFY_SHOP_DOMAIN=greentee-dev.myshopify.com \
//   DATABASE_URL=... DIRECT_URL=... \
//   node apps/admin/scripts/clear-pending-reservations.mjs
//
// The store self-heals both at runtime (reclaims a stale reservation OR an inactive row) and
// re-seeding the campaign cascade-deletes them — this script clears them WITHOUT re-seeding.
//
// SAFE: deletes only (code IS NULL AND older than STALE_MINUTES — never an in-flight mint) OR
// (active = false — a deactivated code whose Shopify discount is already off; the row is just cache).
// A LIVE row (active = true AND code set) is never touched. Idempotent.
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
  const staleMinutes = Number(process.env.STALE_MINUTES ?? '2');
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);

  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (shop === null) {
    console.log(`No shop row for ${domain}; nothing to clear.`);
    return;
  }

  const result = await prisma.giftCodeMapping.deleteMany({
    where: {
      campaign: { shopId: shop.id },
      OR: [
        { code: null, createdAt: { lt: cutoff } }, // zombie reservations
        { active: false }, // superseded/deactivated rows that wedge the key
      ],
    },
  });
  console.log(
    `Cleared ${result.count} wedging row(s) (code IS NULL older than ${staleMinutes}m, OR ` +
      `active=false) for ${domain}. Live codes (active=true with a code) were untouched.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
