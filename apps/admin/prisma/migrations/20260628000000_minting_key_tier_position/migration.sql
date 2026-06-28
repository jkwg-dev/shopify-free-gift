-- Phase 3c Q4 (supersede): the gift-code minting key uses the TIER POSITION instead of the DB tier id,
-- so the key is config-derived + stable across updateCampaign's tier-row recreation (and derivable
-- before any DB write, enabling eager-mint-before-commit). Re-keys existing live codes IN PLACE from
-- their tier's position — no orphaning.

-- 1. Add the new column (nullable for the backfill).
ALTER TABLE "gift_code_mappings" ADD COLUMN "tierPosition" INTEGER;

-- 2. Backfill from each mapping's tier (tierId -> tiers.position). Every live code references a current
--    tier (an active campaign's tiers are never recreated — editing active was refused until now), so
--    every row gets a position.
UPDATE "gift_code_mappings" m
SET "tierPosition" = t."position"
FROM "tiers" t
WHERE t."id" = m."tierId";

-- 3. Safety net: drop any mapping whose tier no longer exists (orphan — its discount is unreachable),
--    so the NOT NULL below cannot fail. None expected for the live data.
DELETE FROM "gift_code_mappings" WHERE "tierPosition" IS NULL;

-- 4. Enforce NOT NULL now that every surviving row has a position.
ALTER TABLE "gift_code_mappings" ALTER COLUMN "tierPosition" SET NOT NULL;

-- 5. Swap the minting unique index from tierId to tierPosition.
DROP INDEX "gift_code_mappings_minting_key";
CREATE UNIQUE INDEX "gift_code_mappings_minting_key" ON "gift_code_mappings"("campaignId", "tierPosition", "resolvedGiftSetHash", "configVersionHash");

-- 6. Drop the old column.
ALTER TABLE "gift_code_mappings" DROP COLUMN "tierId";
