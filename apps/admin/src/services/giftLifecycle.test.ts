import { describe, expect, it } from 'vitest';
import {
  GiftProvisioningError,
  provisionGifts,
  reconcileGiftTagsOnTeardown,
  type GiftTagGateway,
} from './giftLifecycle.js';

type FakeOptions = {
  // products the tag failed to persist on (verifyGiftProductsTagged reports them missing)
  readonly tagMissing?: readonly string[];
  // membership-exclusion result
  readonly excluded?: boolean;
  // collection product count: number, or null to simulate a missing collection
  readonly productCount?: number | null;
};

// Recording fake. resolveGiftProductIds maps variant -> product via a fixed table.
class FakeGiftTagGateway implements GiftTagGateway {
  readonly calls: string[] = [];
  readonly tagged: string[][] = [];
  readonly untagged: string[][] = [];
  private readonly tagMissing: readonly string[];
  private readonly excluded: boolean;
  private readonly productCount: number | null;

  constructor(
    private readonly variantToProduct: Readonly<Record<string, string>>,
    options: FakeOptions = {},
  ) {
    this.tagMissing = options.tagMissing ?? [];
    this.excluded = options.excluded ?? true;
    // NOTE: 'productCount' in options, NOT ??, so an explicit null (missing collection) survives.
    this.productCount = 'productCount' in options ? (options.productCount ?? null) : 16;
  }

  ensureQualifyingCollection(): Promise<{ id: string }> {
    this.calls.push('ensure');
    return Promise.resolve({ id: 'gid://shopify/Collection/shared' });
  }

  resolveGiftProductIds(variantIds: readonly string[]): Promise<readonly string[]> {
    this.calls.push('resolve');
    const products = new Set<string>();
    for (const v of variantIds) {
      const p = this.variantToProduct[v];
      if (p !== undefined) products.add(p);
    }
    return Promise.resolve([...products]);
  }

  tagProductsAsGift(productIds: readonly string[]): Promise<void> {
    this.calls.push('tag');
    this.tagged.push([...productIds]);
    return Promise.resolve();
  }

  untagProductsAsGift(productIds: readonly string[]): Promise<void> {
    this.calls.push('untag');
    this.untagged.push([...productIds]);
    return Promise.resolve();
  }

  verifyGiftProductsTagged(productIds: readonly string[]): Promise<readonly string[]> {
    this.calls.push('verify');
    return Promise.resolve(productIds.filter((id) => this.tagMissing.includes(id)));
  }

  collectionProductCount(): Promise<number | null> {
    this.calls.push('count');
    return Promise.resolve(this.productCount);
  }

  waitForGiftProductsExcluded(): Promise<boolean> {
    this.calls.push('wait');
    return Promise.resolve(this.excluded);
  }
}

describe('provisionGifts — activation ordering + hard-fail gating', () => {
  it('ensures, tags, VERIFIES the tag, waits for exclusion, confirms a non-empty scope (in order)', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA', vB: 'pB' });
    const result = await provisionGifts(gw, ['vA', 'vB']);

    expect(gw.calls).toEqual(['ensure', 'resolve', 'tag', 'verify', 'wait', 'count']);
    expect(gw.tagged).toEqual([['pA', 'pB']]);
    expect(result).toEqual({
      collectionId: 'gid://shopify/Collection/shared',
      taggedProductIds: ['pA', 'pB'],
      qualifyingProductCount: 16,
      ready: true,
    });
  });

  it('HARD-FAILS (does not mint) when membership has not caught up', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA' }, { excluded: false });
    await expect(provisionGifts(gw, ['vA'])).rejects.toBeInstanceOf(GiftProvisioningError);
    expect(gw.calls).not.toContain('count'); // aborted before confirming the scope
  });

  it('HARD-FAILS when the tag did not persist (write_products not granted)', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA' }, { tagMissing: ['pA'] });
    await expect(provisionGifts(gw, ['vA'])).rejects.toMatchObject({
      reason: 'tag-not-applied',
    });
    expect(gw.calls).not.toContain('wait'); // aborted right after verification
  });

  it('HARD-FAILS when the qualifying collection does not exist', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA' }, { productCount: null });
    await expect(provisionGifts(gw, ['vA'])).rejects.toMatchObject({
      reason: 'collection-missing',
    });
  });

  it('HARD-FAILS when the qualifying collection is empty', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA' }, { productCount: 0 });
    await expect(provisionGifts(gw, ['vA'])).rejects.toMatchObject({
      reason: 'collection-empty',
    });
  });

  it('HARD-FAILS when gift variants resolve to no products', async () => {
    const gw = new FakeGiftTagGateway({}); // empty mapping -> nothing resolves
    await expect(provisionGifts(gw, ['vMissing'])).rejects.toMatchObject({
      reason: 'no-products-resolved',
    });
    expect(gw.calls).not.toContain('tag');
  });
});

describe('reconcileGiftTagsOnTeardown — guard', () => {
  it('untags a product only when NO other active campaign still uses it', async () => {
    // pShared is used by both the removed campaign and a remaining active one -> keep tagged.
    // pOnlyRemoved is used only by the removed campaign -> untag.
    const gw = new FakeGiftTagGateway({
      removedShared: 'pShared',
      removedSolo: 'pOnlyRemoved',
      otherShared: 'pShared',
    });

    const untagged = await reconcileGiftTagsOnTeardown(
      gw,
      ['removedShared', 'removedSolo'],
      ['otherShared'],
    );

    expect(untagged).toEqual(['pOnlyRemoved']);
    expect(gw.untagged).toEqual([['pOnlyRemoved']]);
  });

  it('untags nothing (no call) when every removed product is still used elsewhere', async () => {
    const gw = new FakeGiftTagGateway({ r: 'pShared', o: 'pShared' });
    const untagged = await reconcileGiftTagsOnTeardown(gw, ['r'], ['o']);
    expect(untagged).toEqual([]);
    expect(gw.untagged).toEqual([]);
    expect(gw.calls).not.toContain('untag');
  });

  it('untags all removed products when no campaigns remain', async () => {
    const gw = new FakeGiftTagGateway({ r1: 'p1', r2: 'p2' });
    const untagged = await reconcileGiftTagsOnTeardown(gw, ['r1', 'r2'], []);
    expect(new Set(untagged)).toEqual(new Set(['p1', 'p2']));
  });
});
