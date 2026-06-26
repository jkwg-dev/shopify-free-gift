import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../domain.js';
import { campaignListRows } from './campaignList.js';

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c1',
    shopId: 's1',
    name: 'Summer',
    suppression: 'highest-only',
    declineEnabled: true,
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-07-01T00:00:00Z'),
    displayTimezone: 'UTC',
    active: true,
    configVersionHash: 'h',
    tiers: [
      {
        id: 't2',
        campaignId: 'c1',
        position: 2,
        baseThreshold: money(100000, 'CAD'),
        gift: { kind: 'AND', gifts: [{ variantId: 'gA' }, { variantId: 'gB' }] },
        marketThresholds: [],
      },
      {
        id: 't1',
        campaignId: 'c1',
        position: 1,
        baseThreshold: money(50000, 'CAD'),
        gift: {
          kind: 'OR',
          options: [
            { id: 'a', variantId: 'v1' },
            { id: 'b', variantId: 'v2' },
          ],
        },
        marketThresholds: [],
      },
    ],
    ...over,
  };
}

const inWindow = new Date('2026-06-15T00:00:00Z');

describe('campaignListRows', () => {
  it('derives status: live when active AND within the window', () => {
    const [row] = campaignListRows([campaign()], inWindow);
    expect(row!.status).toBe('live');
    expect(row!.liveNow).toBe(true);
  });

  it('inactive when not manually activated (even inside the window)', () => {
    const [row] = campaignListRows([campaign({ active: false })], inWindow);
    expect(row!.status).toBe('inactive');
    expect(row!.liveNow).toBe(false);
  });

  it('scheduled when active but before startsAt; ended when after endsAt', () => {
    expect(campaignListRows([campaign()], new Date('2026-05-01T00:00:00Z'))[0]!.status).toBe(
      'scheduled',
    );
    expect(campaignListRows([campaign()], new Date('2026-08-01T00:00:00Z'))[0]!.status).toBe(
      'ended',
    );
  });

  it('summarizes tiers sorted by position, with kind + gift count', () => {
    const [row] = campaignListRows([campaign()], inWindow);
    expect(row!.tiers.map((t) => [t.position, t.kind, t.giftCount])).toEqual([
      [1, 'OR', 2],
      [2, 'AND', 2],
    ]);
    expect(row!.tiers[0]!.threshold).toEqual(money(50000, 'CAD'));
    expect(row!.startsAt).toBe('2026-06-01T00:00:00.000Z');
    expect(row!.suppression).toBe('highest-only');
  });
});
