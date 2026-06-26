import { configVersionHash, money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { CampaignInputDTO } from '../contract.js';
import {
  FakeCampaignRepository,
  FakeDiscountGateway,
  FakeMappingTable,
  FakeVariantGateway,
} from '../testing/fakes.js';
import { GiftCodeMappingStore, type GiftDiscountSpec } from '../store/giftCodeMapping.js';
import {
  CampaignValidationError,
  createCampaign,
  updateCampaign,
  validateVariants,
  type CampaignServiceDeps,
} from './campaign.js';

function inputWith(thresholdMinor: number, variantId = 'v1'): CampaignInputDTO {
  return {
    name: 'Summer gift',
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: '2026-06-01T00:00:00.000Z',
    endsAt: '2026-06-30T23:59:59.000Z',
    displayTimezone: 'America/New_York',
    tiers: [
      {
        position: 0,
        baseThreshold: money(thresholdMinor, 'USD'),
        gift: { kind: 'OR', options: [{ id: 'a', variantId }] },
        marketThresholds: [],
      },
    ],
  };
}

function makeDeps(deadIds: string[] = []): CampaignServiceDeps & {
  table: FakeMappingTable;
  gateway: FakeDiscountGateway;
} {
  const table = new FakeMappingTable();
  const gateway = new FakeDiscountGateway();
  return {
    campaignRepo: new FakeCampaignRepository(),
    variantGateway: new FakeVariantGateway(deadIds),
    mappingTable: table,
    gateway,
    table,
  };
}

const spec: GiftDiscountSpec = {
  title: 'gift',
  giftVariantIds: ['v1'],
  minimumSubtotal: money(5000, 'USD'),
  qualifyingCollectionId: 'gid://shopify/Collection/test',
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
};

describe('createCampaign', () => {
  it('persists the campaign with the core-computed configVersionHash', async () => {
    const deps = makeDeps();
    const input = inputWith(5000);

    const response = await createCampaign('shop1', input, deps);

    const expectedHash = configVersionHash({
      suppression: 'highest-only',
      tiers: [
        {
          threshold: money(5000, 'USD'),
          gift: { kind: 'OR', options: [{ id: 'a', variantId: 'v1' }] },
        },
      ],
    });
    expect(response.configVersionHash).toBe(expectedHash);
    expect((deps.campaignRepo as FakeCampaignRepository).created[0]?.input.configVersionHash).toBe(
      expectedHash,
    );
  });

  it('rejects a campaign referencing a dead gift variant', async () => {
    const deps = makeDeps(['dead']);
    await expect(createCampaign('shop1', inputWith(5000, 'dead'), deps)).rejects.toBeInstanceOf(
      CampaignValidationError,
    );
  });
});

describe('updateCampaign', () => {
  it('supersedes codes minted under the old config when the scope changes', async () => {
    const deps = makeDeps();
    const created = await createCampaign('shop1', inputWith(5000), deps);

    const store = new GiftCodeMappingStore(deps.table, deps.gateway, {
      generateCode: () => 'CODE-OLD',
      sleep: () => Promise.resolve(),
    });
    await store.getOrCreate(
      {
        campaignId: created.id,
        tierId: 't0',
        resolvedGiftSetHash: 'g1',
        configVersionHash: created.configVersionHash,
      },
      spec,
    );

    const updated = await updateCampaign(created.id, inputWith(6000), deps);

    expect(updated.configVersionHash).not.toBe(created.configVersionHash);
    expect(deps.gateway.deactivated).toEqual(['disc-CODE-OLD']);
  });
});

describe('validateVariants', () => {
  it('returns the validated variants', async () => {
    const deps = makeDeps();
    const result = await validateVariants(['v1', 'v2'], deps);
    expect(result.variants.map((v) => v.id)).toEqual(['v1', 'v2']);
  });
});
