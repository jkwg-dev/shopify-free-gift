import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const initMigration = readFileSync(
  new URL('../../prisma/migrations/20260624000000_init/migration.sql', import.meta.url),
  'utf8',
);
const mintingKeyMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260628000000_minting_key_tier_position/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('GiftCodeMapping minting-key uniqueness', () => {
  it('is declared @@unique on the four key columns (tier POSITION) in schema.prisma', () => {
    expect(schema).toMatch(
      /@@unique\(\[campaignId, tierPosition, resolvedGiftSetHash, configVersionHash\]/,
    );
  });

  it('is enforced by a UNIQUE INDEX on tierPosition in the committed migration', () => {
    expect(mintingKeyMigration).toMatch(
      /CREATE UNIQUE INDEX[^\n]*gift_code_mappings[^\n]*"campaignId", "tierPosition", "resolvedGiftSetHash", "configVersionHash"/,
    );
  });

  it('backfills tierPosition from the tier position and never leaves NULLs (no orphaning)', () => {
    // Backfill from the existing tierId -> tiers.position join, then drop orphans so NOT NULL holds.
    expect(mintingKeyMigration).toMatch(
      /UPDATE "gift_code_mappings"[\s\S]*SET "tierPosition" = t\."position"[\s\S]*WHERE t\."id" = m\."tierId"/,
    );
    expect(mintingKeyMigration).toMatch(
      /DELETE FROM "gift_code_mappings" WHERE "tierPosition" IS NULL/,
    );
    expect(mintingKeyMigration).toMatch(/ALTER COLUMN "tierPosition" SET NOT NULL/);
    expect(mintingKeyMigration).toContain('DROP COLUMN "tierId"');
  });

  it('the init migration creates every model table', () => {
    for (const table of [
      'shops',
      'campaigns',
      'tiers',
      'market_thresholds',
      'gift_code_mappings',
    ]) {
      expect(initMigration).toContain(`CREATE TABLE "${table}"`);
    }
  });
});
