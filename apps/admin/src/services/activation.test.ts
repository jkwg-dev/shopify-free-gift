import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { NewCampaignInput } from '../ports.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import { FakeCampaignRepository, FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import {
  activateCampaign,
  ActivationMintError,
  AnotherCampaignActiveError,
  deactivateCampaign,
  type ActivationDeps,
} from './activation.js';
import { GiftProvisioningError, type GiftTagGateway } from './giftLifecycle.js';

// Minimal inclusion-model gateway: gifts are MEMBERS (untag + wait-for-inclusion); knobs let a test
// force an empty/unsettled scope so provisioning fails.
class FakeGiftTagGateway implements GiftTagGateway {
  readonly untagged: string[] = [];
  constructor(private readonly opts: { qualifyingCount?: number; includedOk?: boolean } = {}) {}
  ensureQualifyingCollection(): Promise<{ id: string }> {
    return Promise.resolve({ id: 'gid://shopify/Collection/q' });
  }
  resolveGiftProductIds(variantIds: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve([...new Set(variantIds.map((v) => `prod-${v}`))]);
  }
  tagProductsAsGift(): Promise<void> {
    return Promise.resolve();
  }
  untagProductsAsGift(ids: readonly string[]): Promise<void> {
    this.untagged.push(...ids);
    return Promise.resolve();
  }
  verifyGiftProductsTagged(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  collectionProductCount(): Promise<number | null> {
    return Promise.resolve(this.opts.qualifyingCount ?? 5);
  }
  waitForGiftProductsExcluded(): Promise<boolean> {
    return Promise.resolve(true);
  }
  waitForGiftProductsIncluded(): Promise<boolean> {
    return Promise.resolve(this.opts.includedOk ?? true);
  }
}

// tier 1 OR(2) + tier 2 AND(2) + tier 3 OR(3) => 2 + 1 + 3 = 6 mint targets (one code per resolved set).
function tiers(): NewCampaignInput['tiers'] {
  return [
    {
      position: 1,
      baseThreshold: money(50000, 'CAD'),
      gift: {
        kind: 'OR',
        options: [
          { id: 'a', variantId: 'v/a' },
          { id: 'b', variantId: 'v/b' },
        ],
      },
      marketThresholds: [],
    },
    {
      position: 2,
      baseThreshold: money(100000, 'CAD'),
      gift: { kind: 'AND', gifts: [{ variantId: 'v/c' }, { variantId: 'v/d' }] },
      marketThresholds: [],
    },
    {
      position: 3,
      baseThreshold: money(150000, 'CAD'),
      gift: {
        kind: 'OR',
        options: [
          { id: 'x', variantId: 'v/x' },
          { id: 'y', variantId: 'v/y' },
          { id: 'z', variantId: 'v/z' },
        ],
      },
      marketThresholds: [],
    },
  ];
}

async function seed(repo: FakeCampaignRepository, shopId: string, name: string): Promise<string> {
  const c = await repo.create(shopId, {
    name,
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: new Date('2026-07-01T00:00:00Z'),
    endsAt: new Date('2026-07-31T00:00:00Z'),
    displayTimezone: 'UTC',
    configVersionHash: `h-${name}`,
    tiers: tiers(),
  });
  return c.id;
}

function makeDeps(
  repo: FakeCampaignRepository,
  opts: { gateway?: FakeGiftTagGateway; discount?: FakeDiscountGateway } = {},
): ActivationDeps & { discount: FakeDiscountGateway } {
  const discount = opts.discount ?? new FakeDiscountGateway();
  return {
    campaignRepo: repo,
    gateway: opts.gateway ?? new FakeGiftTagGateway(),
    mappingStore: new GiftCodeMappingStore(new FakeMappingTable(), discount, {
      sleep: () => Promise.resolve(),
    }),
    giftsIncluded: true,
    discount,
  };
}

describe('activateCampaign (C2: provision + eager-mint, flip last)', () => {
  it('eager-mints one code per resolved gift-set then flips active LAST', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);

    const res = await activateCampaign('shop1', id, deps);

    expect(res?.active).toBe(true);
    expect((await repo.findById(id))?.active).toBe(true);
    expect(deps.discount.createCount).toBe(6); // 2 (OR) + 1 (AND) + 3 (OR)
  });

  it('does NOT flip active when provisioning fails (empty qualifying scope) — no mint', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo, { gateway: new FakeGiftTagGateway({ qualifyingCount: 0 }) });

    await expect(activateCampaign('shop1', id, deps)).rejects.toBeInstanceOf(GiftProvisioningError);
    expect((await repo.findById(id))?.active).toBe(false);
    expect(deps.discount.createCount).toBe(0);
  });

  it('does NOT flip active when a code fails to mint (ActivationMintError names the failures)', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo, {
      discount: new FakeDiscountGateway({ failWith: new Error('boom') }),
    });

    await expect(activateCampaign('shop1', id, deps)).rejects.toBeInstanceOf(ActivationMintError);
    expect((await repo.findById(id))?.active).toBe(false);
  });

  it('rejects (before provisioning) when a DIFFERENT campaign is active — ≤ 1 active', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', a, deps);
    const minted = deps.discount.createCount; // A's 6

    await expect(activateCampaign('shop1', b, deps)).rejects.toBeInstanceOf(
      AnotherCampaignActiveError,
    );
    expect(deps.discount.createCount).toBe(minted); // B never provisioned/minted
    expect((await repo.findById(b))?.active).toBe(false);
    expect((await repo.findById(a))?.active).toBe(true);
  });

  it('is idempotent when already active (no re-mint)', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', id, deps);
    const minted = deps.discount.createCount;

    const res = await activateCampaign('shop1', id, deps);
    expect(res?.active).toBe(true);
    expect(deps.discount.createCount).toBe(minted); // not re-minted
  });

  it('returns null (404) for another shop / unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    expect(await activateCampaign('shop2', id, makeDeps(repo))).toBeNull();
    expect(await activateCampaign('shop1', 'nope', makeDeps(repo))).toBeNull();
  });
});

describe('deactivateCampaign', () => {
  it('flips active to false (idempotent), and a different campaign can then activate', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    await activateCampaign('shop1', a, makeDeps(repo));

    const res = await deactivateCampaign('shop1', a, { campaignRepo: repo });
    expect(res?.active).toBe(false);
    // idempotent
    expect((await deactivateCampaign('shop1', a, { campaignRepo: repo }))?.active).toBe(false);
    // now B can activate (no longer blocked)
    expect((await activateCampaign('shop1', b, makeDeps(repo)))?.active).toBe(true);
  });

  it('returns null (404) for another shop / unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    expect(await deactivateCampaign('shop2', id, { campaignRepo: repo })).toBeNull();
    expect(await deactivateCampaign('shop1', 'nope', { campaignRepo: repo })).toBeNull();
  });
});
