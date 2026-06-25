import { describe, expect, it } from 'vitest';
import type { GiftConfig } from './gifts.js';
import { configVersionHash, resolvedGiftSetHash, type ConfigVersionInput } from './minting.js';
import { money } from './money.js';

const andGift = (variants: string[]): GiftConfig => ({
  kind: 'AND',
  gifts: variants.map((variantId) => ({ variantId })),
});

describe('resolvedGiftSetHash', () => {
  it('is deterministic and order-independent', () => {
    expect(resolvedGiftSetHash([{ variantId: 'a' }, { variantId: 'b' }])).toBe(
      resolvedGiftSetHash([{ variantId: 'b' }, { variantId: 'a' }]),
    );
  });

  it('differs for a different gift-set (distinct OR choices key distinct codes)', () => {
    expect(resolvedGiftSetHash([{ variantId: 'a' }])).not.toBe(
      resolvedGiftSetHash([{ variantId: 'b' }]),
    );
  });

  it('is a 64-char hex digest', () => {
    expect(resolvedGiftSetHash([{ variantId: 'a' }])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('configVersionHash — OR gift config', () => {
  const withOr = (optionVariant: string): ConfigVersionInput => ({
    suppression: 'highest-only',
    tiers: [
      {
        threshold: money(5000, 'USD'),
        gift: {
          kind: 'OR',
          options: [
            { id: 'opt-a', variantId: 'a' },
            { id: 'opt-b', variantId: optionVariant },
          ],
        },
      },
    ],
  });

  it('is stable across OR option ordering', () => {
    const reordered: ConfigVersionInput = {
      suppression: 'highest-only',
      tiers: [
        {
          threshold: money(5000, 'USD'),
          gift: {
            kind: 'OR',
            options: [
              { id: 'opt-b', variantId: 'b' },
              { id: 'opt-a', variantId: 'a' },
            ],
          },
        },
      ],
    };
    expect(configVersionHash(reordered)).toBe(configVersionHash(withOr('b')));
  });

  it('changes when an OR option variant changes', () => {
    expect(configVersionHash(withOr('b2'))).not.toBe(configVersionHash(withOr('b')));
  });
});

describe('configVersionHash', () => {
  const base: ConfigVersionInput = {
    suppression: 'highest-only',
    tiers: [
      { threshold: money(5000, 'USD'), gift: andGift(['s']) },
      { threshold: money(10000, 'USD'), gift: andGift(['g']) },
    ],
  };

  it('is stable across tier ordering', () => {
    const reordered: ConfigVersionInput = { ...base, tiers: [...base.tiers].reverse() };
    expect(configVersionHash(reordered)).toBe(configVersionHash(base));
  });

  it('changes when a threshold changes', () => {
    const edited: ConfigVersionInput = {
      ...base,
      tiers: [
        { threshold: money(6000, 'USD'), gift: andGift(['s']) },
        { threshold: money(10000, 'USD'), gift: andGift(['g']) },
      ],
    };
    expect(configVersionHash(edited)).not.toBe(configVersionHash(base));
  });

  it('changes when a gift-set changes', () => {
    const edited: ConfigVersionInput = {
      ...base,
      tiers: [
        { threshold: money(5000, 'USD'), gift: andGift(['s2']) },
        { threshold: money(10000, 'USD'), gift: andGift(['g']) },
      ],
    };
    expect(configVersionHash(edited)).not.toBe(configVersionHash(base));
  });

  it('changes when suppression mode changes', () => {
    expect(configVersionHash({ ...base, suppression: 'cumulative' })).not.toBe(
      configVersionHash(base),
    );
  });
});
