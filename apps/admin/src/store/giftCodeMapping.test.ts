import { money } from '@free-gift-engine/core';
import { EmptyQualifyingScopeError } from '@free-gift-engine/shopify';
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
  qualifyingCollectionId: 'gid://shopify/Collection/test',
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

  it('a hard mint failure (empty scope) releases the reservation and surfaces the real error', async () => {
    const table = new FakeMappingTable();
    const emptyScope = new EmptyQualifyingScopeError('gid://shopify/Collection/test', 'empty');
    const gateway = new FakeDiscountGateway({ failWith: emptyScope });
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    await expect(store.getOrCreate(key, spec)).rejects.toBe(emptyScope);
    expect(await table.findByKey(key)).toBeNull(); // no dangling reservation
  });

  it('a concurrent waiter gets the real error, not a timeout, when the holder fails to mint', async () => {
    const table = new FakeMappingTable();
    const emptyScope = new EmptyQualifyingScopeError('gid://shopify/Collection/test', 'empty');
    const gateway = new FakeDiscountGateway({ failWith: emptyScope });
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    const results = await Promise.allSettled([
      store.getOrCreate(key, spec),
      store.getOrCreate(key, spec),
    ]);

    // BOTH surface the underlying empty-scope error — neither blocks until the concurrency timeout.
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBe(emptyScope);
    }
    expect(await table.findByKey(key)).toBeNull();
  });

  it('recovers a stale/abandoned reservation instead of wedging the key forever', async () => {
    const table = new FakeMappingTable();
    // A zombie reservation whose holder died mid-flight (old createdAt, never resolved).
    table.seedAbandonedPending(key);
    const gateway = new FakeDiscountGateway();
    const store = new GiftCodeMappingStore(table, gateway, {
      generateCode: sequentialCodes(),
      sleep: immediate,
    });

    const result = await store.getOrCreate(key, spec);

    expect(gateway.createCount).toBe(1); // reclaimed and minted, no timeout
    expect(result.code).toBe('CODE-1');
    expect(result.discountId).toBe('disc-CODE-1');
  });
});
