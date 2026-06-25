import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { MintingKey } from '../domain.js';
import { FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import { GiftCodeMappingStore, type GiftDiscountSpec } from '../store/giftCodeMapping.js';
import { supersedeStaleDiscounts } from './supersede.js';

const spec: GiftDiscountSpec = {
  title: 'Gold gift',
  giftVariantIds: ['gid://shopify/ProductVariant/1'],
  minimumSubtotal: money(10000, 'USD'),
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
};

const keyWithHash = (configVersionHash: string): MintingKey => ({
  campaignId: 'c1',
  tierId: 't1',
  resolvedGiftSetHash: 'g1',
  configVersionHash,
});

describe('supersedeStaleDiscounts', () => {
  it('deactivates stale codes on a config change, then a later resolve mints a fresh code', async () => {
    const table = new FakeMappingTable();
    const gateway = new FakeDiscountGateway();
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: (() => {
        let n = 0;
        return () => `CODE-${(n += 1)}`;
      })(),
      sleep: () => Promise.resolve(),
    });

    // Mint a code under the original config.
    const original = await store.getOrCreate(keyWithHash('old'), spec);
    expect(original.code).toBe('CODE-1');

    // Config changes -> supersede everything not on the new hash.
    const result = await supersedeStaleDiscounts('c1', 'new', { mappingTable: table, gateway });

    expect(result.deactivated).toBe(1);
    expect(gateway.deactivated).toEqual(['disc-CODE-1']);
    expect(await table.findActiveByCampaign('c1')).toHaveLength(0);

    // A resolve under the new config mints a brand-new code.
    const superseding = await store.getOrCreate(keyWithHash('new'), spec);
    expect(superseding.code).toBe('CODE-2');
    expect(gateway.createCount).toBe(2);
  });

  it('is a no-op when nothing is stale (hash unchanged)', async () => {
    const table = new FakeMappingTable();
    const gateway = new FakeDiscountGateway();
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: () => 'CODE-X',
      sleep: () => Promise.resolve(),
    });
    await store.getOrCreate(keyWithHash('current'), spec);

    const result = await supersedeStaleDiscounts('c1', 'current', { mappingTable: table, gateway });

    expect(result.deactivated).toBe(0);
    expect(gateway.deactivated).toEqual([]);
  });
});
