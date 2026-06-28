import { describe, expect, it } from 'vitest';
import type { MintingKey } from '../domain.js';
import { UniqueKeyViolationError } from '../ports.js';
import { PrismaGiftCodeMappingTable } from './repositories.js';
import type { GiftCodeMappingRow, PrismaDelegate, PrismaLike } from './prismaLike.js';

const key: MintingKey = {
  campaignId: 'c1',
  tierId: 't1',
  resolvedGiftSetHash: 'g1',
  configVersionHash: 'v1',
};

const unused = (): never => {
  throw new Error('delegate should not be called in this test');
};

function makePrisma(overrides: Partial<PrismaDelegate<GiftCodeMappingRow>>): PrismaLike {
  const stub: PrismaDelegate<never> = {
    findUnique: unused,
    findMany: unused,
    create: unused,
    update: unused,
    updateMany: unused,
    delete: unused,
    upsert: unused,
  };
  return {
    shop: stub,
    campaign: stub,
    giftCodeMapping: {
      findUnique: unused,
      findMany: unused,
      create: unused,
      update: unused,
      updateMany: unused,
      delete: unused,
      upsert: unused,
      ...overrides,
    },
    $transaction: unused,
  };
}

const row = (code: string | null): GiftCodeMappingRow => ({
  id: 'm1',
  ...key,
  code,
  discountId: code === null ? null : `disc-${code}`,
  active: true,
  createdAt: new Date(0),
});

describe('PrismaGiftCodeMappingTable', () => {
  it('translates a Prisma P2002 unique violation into UniqueKeyViolationError', async () => {
    const table = new PrismaGiftCodeMappingTable(
      makePrisma({ create: () => Promise.reject({ code: 'P2002' }) }),
    );
    await expect(table.insertPending(key)).rejects.toBeInstanceOf(UniqueKeyViolationError);
  });

  it('rethrows non-unique-violation errors unchanged', async () => {
    const table = new PrismaGiftCodeMappingTable(
      makePrisma({ create: () => Promise.reject(new Error('connection reset')) }),
    );
    await expect(table.insertPending(key)).rejects.toThrow('connection reset');
  });

  it('maps a reserved (pending) row with a null code', async () => {
    const table = new PrismaGiftCodeMappingTable(
      makePrisma({ create: () => Promise.resolve(row(null)) }),
    );
    const mapping = await table.insertPending(key);
    expect(mapping.code).toBeNull();
    expect(mapping.campaignId).toBe('c1');
  });

  it('maps a finalized row from findByKey', async () => {
    const table = new PrismaGiftCodeMappingTable(
      makePrisma({ findUnique: () => Promise.resolve(row('CODE')) }),
    );
    const mapping = await table.findByKey(key);
    expect(mapping?.code).toBe('CODE');
    expect(mapping?.discountId).toBe('disc-CODE');
  });
});
