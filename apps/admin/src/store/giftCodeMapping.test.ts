import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { MintingKey } from '../domain.js';
import { FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import { GiftCodeMappingStore, type GiftDiscountSpec } from './giftCodeMapping.js';

const key: MintingKey = {
  campaignId: 'c1',
  tierId: 't1',
  resolvedGiftSetHash: 'g1',
  configVersionHash: 'v1',
};

const spec: GiftDiscountSpec = {
  title: 'Gold gift',
  giftVariantIds: ['gid://shopify/ProductVariant/1'],
  minimumSubtotal: money(10000, 'USD'),
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
};

function sequentialCodes(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `CODE-${n}`;
  };
}

const immediate = (): Promise<void> => Promise.resolve();

describe('GiftCodeMappingStore.getOrCreate', () => {
  it('two concurrent calls for one key mint exactly one discount and share the code', async () => {
    const table = new FakeMappingTable();
    const gateway = new FakeDiscountGateway();
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    const [a, b] = await Promise.all([store.getOrCreate(key, spec), store.getOrCreate(key, spec)]);

    expect(gateway.createCount).toBe(1);
    expect(a.code).toBe('CODE-1');
    expect(b.code).toBe('CODE-1');
    expect(a.discountId).toBe('disc-CODE-1');
  });

  it('reuses the stored code on a later call (idempotent, no second mint)', async () => {
    const table = new FakeMappingTable();
    const gateway = new FakeDiscountGateway();
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    const first = await store.getOrCreate(key, spec);
    const second = await store.getOrCreate(key, spec);

    expect(gateway.createCount).toBe(1);
    expect(second.code).toBe(first.code);
  });

  it('regenerates the code on a duplicate-code collision', async () => {
    const table = new FakeMappingTable();
    const gateway = new FakeDiscountGateway({ duplicateFirst: 1 });
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    const result = await store.getOrCreate(key, spec);

    expect(gateway.createCount).toBe(2);
    expect(result.code).toBe('CODE-2');
  });

  it('releases the reservation if minting ultimately fails', async () => {
    const table = new FakeMappingTable();
    // Always duplicates: exhausts retries and throws.
    const gateway = new FakeDiscountGateway({ duplicateFirst: 99 });
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
      maxCodeAttempts: 3,
    });

    await expect(store.getOrCreate(key, spec)).rejects.toBeTruthy();
    // Reservation rolled back, so a fresh attempt can proceed.
    expect(await table.findByKey(key)).toBeNull();
  });
});
