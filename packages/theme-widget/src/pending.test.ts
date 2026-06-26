import { describe, expect, it } from 'vitest';
import { PENDING_DELAY_MS, PENDING_MAX_MS, confidentDimVariants } from './pending.js';

describe('confidentDimVariants (pure)', () => {
  it('returns wanted gift variants that map to exactly ONE cart row', () => {
    expect(confidentDimVariants(['1', '2', '3'], ['2', '3'])).toEqual(['2', '3']);
  });

  it('skips a variant with a paid duplicate (>1 row) — never dims the wrong/paid row', () => {
    expect(confidentDimVariants(['1', '2', '2'], ['2'])).toEqual([]);
  });

  it('skips a wanted variant not yet in the cart (0 rows)', () => {
    expect(confidentDimVariants(['1'], ['9'])).toEqual([]);
  });

  it('only dims wanted variants — never a non-gift row', () => {
    expect(confidentDimVariants(['7', '8'], ['8'])).toEqual(['8']);
  });
});

describe('pending timing constants', () => {
  it('engages after a flicker delay and is capped by a safety timeout', () => {
    expect(PENDING_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(PENDING_DELAY_MS).toBeLessThanOrEqual(400);
    expect(PENDING_MAX_MS).toBeGreaterThan(PENDING_DELAY_MS);
  });
});
