import { describe, expect, it } from 'vitest';
import {
  provisionGifts,
  reconcileGiftTagsOnTeardown,
  type GiftTagGateway,
} from './giftLifecycle.js';

// Recording fake. resolveGiftProductIds maps variant -> product via a fixed table.
class FakeGiftTagGateway implements GiftTagGateway {
  readonly calls: string[] = [];
  readonly tagged: string[][] = [];
  readonly untagged: string[][] = [];

  constructor(
    private readonly variantToProduct: Readonly<Record<string, string>>,
    private readonly excluded: boolean = true,
  ) {}

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

  waitForGiftProductsExcluded(): Promise<boolean> {
    this.calls.push('wait');
    return Promise.resolve(this.excluded);
  }
}

describe('provisionGifts — activation ordering', () => {
  it('ensures the collection, tags gifts, THEN waits for exclusion (in order)', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA', vB: 'pB' });
    const result = await provisionGifts(gw, ['vA', 'vB']);

    expect(gw.calls).toEqual(['ensure', 'resolve', 'tag', 'wait']);
    expect(gw.tagged).toEqual([['pA', 'pB']]);
    expect(result).toEqual({ collectionId: 'gid://shopify/Collection/shared', ready: true });
  });

  it('reports not-ready when membership has not caught up (caller must not activate codes)', async () => {
    const gw = new FakeGiftTagGateway({ vA: 'pA' }, false);
    const result = await provisionGifts(gw, ['vA']);
    expect(result.ready).toBe(false);
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
