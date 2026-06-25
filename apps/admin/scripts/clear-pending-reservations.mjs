// Clear stale/zombie gift-code RESERVATIONS (un-minted rows: code IS NULL) for a shop.
//
//   SHOPIFY_SHOP_DOMAIN=greentee-dev.myshopify.com \
//   DATABASE_URL=... DIRECT_URL=... \
//   node apps/admin/scripts/clear-pending-reservations.mjs
//
// Why: a reservation whose holder died mid-mint (killed serverless invocation) can linger as a
// pending row. The store now self-heals these at runtime (it reclaims a reservation older than
// staleReservationMs) and re-seeding the campaign cascade-deletes them — but this script clears them
// WITHOUT re-seeding, e.g. to unwedge a key on the current campaign before the staleness window.
//
// SAFE: only deletes rows with code IS NULL (never a finalized/active code) AND older than
// STALE_MINUTES (default 2) so an in-flight mint is not nuked. Idempotent.
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
    where: { code: null, createdAt: { lt: cutoff }, campaign: { shopId: shop.id } },
  });
  console.log(
    `Cleared ${result.count} stale reservation(s) (code IS NULL, older than ${staleMinutes}m) ` +
      `for ${domain}. Finalized/active codes were untouched.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
