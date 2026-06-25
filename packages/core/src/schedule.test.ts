import { describe, expect, it } from 'vitest';
import { isCampaignActive, type Schedule } from './schedule.js';

// Boundaries are absolute UTC instants. Using explicit Z-suffixed ISO strings keeps the test
// independent of the machine's local time zone.
const schedule: Schedule = {
  startsAt: new Date('2026-06-01T00:00:00.000Z'),
  endsAt: new Date('2026-06-30T23:59:59.999Z'),
};

describe('isCampaignActive', () => {
  it('is inactive strictly before startsAt', () => {
    expect(isCampaignActive(schedule, new Date('2026-05-31T23:59:59.999Z'))).toBe(false);
  });

  it('is active exactly at startsAt (inclusive)', () => {
    expect(isCampaignActive(schedule, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);
  });

  it('is active within the window', () => {
    expect(isCampaignActive(schedule, new Date('2026-06-15T12:00:00.000Z'))).toBe(true);
  });

  it('is active exactly at endsAt (inclusive)', () => {
    expect(isCampaignActive(schedule, new Date('2026-06-30T23:59:59.999Z'))).toBe(true);
  });

  it('is inactive strictly after endsAt', () => {
    expect(isCampaignActive(schedule, new Date('2026-07-01T00:00:00.000Z'))).toBe(false);
  });

  it('compares absolute instants, not wall-clock — an offset time inside the window is active', () => {
    // 2026-06-15T20:00:00-05:00 === 2026-06-16T01:00:00Z, which is inside the window.
    expect(isCampaignActive(schedule, new Date('2026-06-15T20:00:00.000-05:00'))).toBe(true);
  });
});
