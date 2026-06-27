import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { CampaignInputDTO } from '../contract.js';
import { FakeCampaignRepository } from '../testing/fakes.js';
import { activateCampaign, AnotherCampaignActiveError, deactivateCampaign } from './activation.js';

function input(name: string): CampaignInputDTO {
  return {
    name,
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-07-31T00:00:00.000Z',
    displayTimezone: 'UTC',
    tiers: [
      {
        position: 1,
        baseThreshold: money(50000, 'CAD'),
        gift: { kind: 'OR', options: [{ id: 'a', variantId: 'gid://v/1' }] },
        marketThresholds: [],
      },
    ],
  };
}

// A NewCampaignInput is what the repo.create takes; build it from the DTO shape directly.
async function seedDraft(
  repo: FakeCampaignRepository,
  shopId: string,
  name: string,
): Promise<string> {
  const i = input(name);
  const campaign = await repo.create(shopId, {
    name: i.name,
    suppression: i.suppression,
    declineEnabled: i.declineEnabled,
    startsAt: new Date(i.startsAt),
    endsAt: new Date(i.endsAt),
    displayTimezone: i.displayTimezone,
    configVersionHash: `hash-${name}`,
    tiers: i.tiers.map((t) => ({
      position: t.position,
      baseThreshold: t.baseThreshold,
      gift: t.gift,
      marketThresholds: [],
    })),
  });
  return campaign.id;
}

describe('activateCampaign', () => {
  it('activates an inactive draft when none is active', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');

    const res = await activateCampaign('shop1', id, { campaignRepo: repo });

    expect(res?.active).toBe(true);
    expect((await repo.findById(id))?.active).toBe(true);
  });

  it('rejects activation when a DIFFERENT campaign is already active', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seedDraft(repo, 'shop1', 'Smoke');
    const b = await seedDraft(repo, 'shop1', 'July');
    await activateCampaign('shop1', a, { campaignRepo: repo });

    await expect(activateCampaign('shop1', b, { campaignRepo: repo })).rejects.toBeInstanceOf(
      AnotherCampaignActiveError,
    );
    // B stays inactive; A stays active (no half-state).
    expect((await repo.findById(b))?.active).toBe(false);
    expect((await repo.findById(a))?.active).toBe(true);
  });

  it('is idempotent when the campaign is already active', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');
    await activateCampaign('shop1', id, { campaignRepo: repo });

    const res = await activateCampaign('shop1', id, { campaignRepo: repo });
    expect(res?.active).toBe(true);
  });

  it('returns null (404) for a campaign owned by another shop', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');
    expect(await activateCampaign('shop2', id, { campaignRepo: repo })).toBeNull();
  });

  it('returns null (404) for an unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    expect(await activateCampaign('shop1', 'nope', { campaignRepo: repo })).toBeNull();
  });

  it('does not count THIS campaign as a blocker when re-activating it', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');
    await activateCampaign('shop1', id, { campaignRepo: repo });
    // re-activating the SAME active campaign must not throw
    await expect(activateCampaign('shop1', id, { campaignRepo: repo })).resolves.not.toBeNull();
  });
});

describe('deactivateCampaign', () => {
  it('deactivates an active campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');
    await activateCampaign('shop1', id, { campaignRepo: repo });

    const res = await deactivateCampaign('shop1', id, { campaignRepo: repo });
    expect(res?.active).toBe(false);
    expect((await repo.findById(id))?.active).toBe(false);
  });

  it('is idempotent when already inactive, and allows re-activating afterwards', async () => {
    const repo = new FakeCampaignRepository();
    const a = await seedDraft(repo, 'shop1', 'Smoke');
    const b = await seedDraft(repo, 'shop1', 'July');
    await activateCampaign('shop1', a, { campaignRepo: repo });

    // deactivate A, then B can activate (no longer blocked) — the C1 manual replace flow.
    await deactivateCampaign('shop1', a, { campaignRepo: repo });
    const res = await activateCampaign('shop1', b, { campaignRepo: repo });
    expect(res?.active).toBe(true);
  });

  it('returns null (404) for another shop / unknown campaign', async () => {
    const repo = new FakeCampaignRepository();
    const id = await seedDraft(repo, 'shop1', 'July');
    expect(await deactivateCampaign('shop2', id, { campaignRepo: repo })).toBeNull();
    expect(await deactivateCampaign('shop1', 'nope', { campaignRepo: repo })).toBeNull();
  });
});
