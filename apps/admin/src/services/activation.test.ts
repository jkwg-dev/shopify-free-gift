import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { NewCampaignInput } from '../ports.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import { FakeCampaignRepository, FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import {
  activateCampaign,
  ActivationMintError,
  ActivationWindowError,
  deactivateCampaign,
  ReplaceConfirmationRequiredError,
  type ActivationDeps,
} from './activation.js';
import { GiftProvisioningError, type GiftTagGateway } from './giftLifecycle.js';

const NOW = new Date('2026-07-10T00:00:00Z'); // inside the default [startsAt, endsAt] window

// Minimal inclusion-model gateway; knobs force an empty/unsettled scope so provisioning fails.
class FakeGiftTagGateway implements GiftTagGateway {
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
  untagProductsAsGift(): Promise<void> {
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

// tier 1 OR(2) + tier 2 AND(2) + tier 3 OR(3) => 6 mint targets.
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

async function seed(
  repo: FakeCampaignRepository,
  shopId: string,
  name: string,
  window: { startsAt?: string; endsAt?: string } = {},
): Promise<string> {
  const c = await repo.create(shopId, {
    name,
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: new Date(window.startsAt ?? '2026-07-01T00:00:00Z'),
    endsAt: new Date(window.endsAt ?? '2026-07-31T00:00:00Z'),
    displayTimezone: 'UTC',
    configVersionHash: `h-${name}`,
    tiers: tiers(),
  });
  return c.id;
}

function makeDeps(
  repo: FakeCampaignRepository,
  opts: { gateway?: FakeGiftTagGateway; discount?: FakeDiscountGateway; now?: Date } = {},
): ActivationDeps & { discount: FakeDiscountGateway } {
  const discount = opts.discount ?? new FakeDiscountGateway();
  return {
    campaignRepo: repo,
    gateway: opts.gateway ?? new FakeGiftTagGateway(),
    mappingStore: new GiftCodeMappingStore(new FakeMappingTable(), discount, {
      sleep: () => Promise.resolve(),
    }),
    giftsIncluded: true,
    now: () => opts.now ?? NOW,
    discount,
  };
}

describe('activateCampaign (C3: confirm-and-replace swap, start-now, teardown)', () => {
  it('activates when none is active: eager-mints all targets then flips active', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);

    const res = await activateCampaign('shop1', id, deps);

    expect(res?.active).toBe(true);
    expect((await repo.findById(id))?.active).toBe(true);
    expect(deps.discount.createCount).toBe(6);
  });

  it('requires confirmation before replacing a live campaign (no side effects)', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', a, deps);
    const mintedForA = deps.discount.createCount;

    await expect(activateCampaign('shop1', b, deps)).rejects.toBeInstanceOf(
      ReplaceConfirmationRequiredError,
    );
    // No swap, no mint for B — A keeps serving.
    expect(deps.discount.createCount).toBe(mintedForA);
    expect((await repo.findById(a))?.active).toBe(true);
    expect((await repo.findById(b))?.active).toBe(false);
  });

  it('with confirmReplace: mints B, swaps atomically (never 0/2 active), tears down A', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', a, deps);

    const res = await activateCampaign('shop1', b, deps, { confirmReplace: true });

    expect(res?.active).toBe(true);
    expect((await repo.findById(b))?.active).toBe(true);
    // Exactly one active for the shop, and it's B (never 0/2).
    expect((await repo.findById(a))?.active).toBe(false);
    expect((await repo.findActiveByShop('shop1'))?.id).toBe(b);
    // A's 6 codes were torn down (deleted in Shopify).
    expect(deps.discount.deleted.length).toBe(6);
  });

  it('leaves the prior campaign active when provisioning fails (no swap, no gap)', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    const good = makeDeps(repo);
    await activateCampaign('shop1', a, good);

    const bad = makeDeps(repo, { gateway: new FakeGiftTagGateway({ qualifyingCount: 0 }) });
    await expect(
      activateCampaign('shop1', b, bad, { confirmReplace: true }),
    ).rejects.toBeInstanceOf(GiftProvisioningError);
    expect((await repo.findById(a))?.active).toBe(true);
    expect((await repo.findById(b))?.active).toBe(false);
  });

  it('leaves the prior campaign active when a code fails to mint (no swap)', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seed(repo, 'shop1', 'Smoke');
    const b = await seed(repo, 'shop1', 'July');
    await activateCampaign('shop1', a, makeDeps(repo));

    const bad = makeDeps(repo, {
      discount: new FakeDiscountGateway({ failWith: new Error('boom') }),
    });
    await expect(
      activateCampaign('shop1', b, bad, { confirmReplace: true }),
    ).rejects.toBeInstanceOf(ActivationMintError);
    expect((await repo.findById(a))?.active).toBe(true);
    expect((await repo.findById(b))?.active).toBe(false);
  });

  it('start-now: overrides a FUTURE startsAt to now so it serves immediately', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July', { startsAt: '2026-07-20T00:00:00Z' }); // future vs NOW
    const deps = makeDeps(repo);

    const res = await activateCampaign('shop1', id, deps);

    expect(res?.startsAt).toBe(NOW.toISOString());
    expect((await repo.findById(id))?.startsAt.toISOString()).toBe(NOW.toISOString());
  });

  it('keeps a past startsAt as-is (already within the window)', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July', { startsAt: '2026-07-01T00:00:00Z' }); // past vs NOW
    const deps = makeDeps(repo);

    const res = await activateCampaign('shop1', id, deps);
    expect(res?.startsAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('refuses to activate a campaign whose window already ended', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July', { endsAt: '2026-07-05T00:00:00Z' }); // before NOW
    await expect(activateCampaign('shop1', id, makeDeps(repo))).rejects.toBeInstanceOf(
      ActivationWindowError,
    );
    expect((await repo.findById(id))?.active).toBe(false);
  });

  it('is idempotent when already active (no re-mint)', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', id, deps);
    const minted = deps.discount.createCount;

    expect((await activateCampaign('shop1', id, deps))?.active).toBe(true);
    expect(deps.discount.createCount).toBe(minted);
  });

  it('returns null (404) for another shop / unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    expect(await activateCampaign('shop2', id, makeDeps(repo))).toBeNull();
    expect(await activateCampaign('shop1', 'nope', makeDeps(repo))).toBeNull();
  });
});

describe('deactivateCampaign (C3: flip + teardown)', () => {
  it('flips active off AND tears down the campaign codes', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', id, deps);

    const res = await deactivateCampaign('shop1', id, deps);
    expect(res?.active).toBe(false);
    expect((await repo.findById(id))?.active).toBe(false);
    expect(deps.discount.deleted.length).toBe(6); // all of the campaign's codes deleted
  });

  it('re-activating after teardown mints FRESH codes (deleted rows free the key)', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    const deps = makeDeps(repo);
    await activateCampaign('shop1', id, deps); // mints 6
    await deactivateCampaign('shop1', id, deps); // deletes 6

    await activateCampaign('shop1', id, deps); // must mint 6 AGAIN (fresh)
    expect(deps.discount.createCount).toBe(12); // 6 + 6
    expect((await repo.findById(id))?.active).toBe(true);
  });

  it('returns null (404) for another shop / unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seed(repo, 'shop1', 'July');
    expect(await deactivateCampaign('shop2', id, makeDeps(repo))).toBeNull();
    expect(await deactivateCampaign('shop1', 'nope', makeDeps(repo))).toBeNull();
  });
});
