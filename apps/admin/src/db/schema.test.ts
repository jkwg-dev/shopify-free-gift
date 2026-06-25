import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../prisma/migrations/20260624000000_init/migration.sql', import.meta.url),
  'utf8',
);

describe('GiftCodeMapping minting-key uniqueness', () => {
  it('is declared @@unique on the four key columns in schema.prisma', () => {
    expect(schema).toMatch(
      /@@unique\(\[campaignId, tierId, resolvedGiftSetHash, configVersionHash\]/,
    );
  });

  it('is enforced by a UNIQUE INDEX in the committed migration', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[^\n]*gift_code_mappings[^\n]*"campaignId", "tierId", "resolvedGiftSetHash", "configVersionHash"/,
    );
  });

  it('the migration creates every model table', () => {
    for (const table of [
      'shops',
      'campaigns',
      'tiers',
      'market_thresholds',
      'gift_code_mappings',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
  });
});
