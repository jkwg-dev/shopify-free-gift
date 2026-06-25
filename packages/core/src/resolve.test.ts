import { describe, expect, it } from 'vitest';
import type { CartLine } from './cart.js';
import { InvalidGiftChoiceError } from './gifts.js';
import { money } from './money.js';
import { resolveActiveGifts, type Campaign, type ResolveInput } from './resolve.js';

const schedule = {
  startsAt: new Date('2026-06-01T00:00:00.000Z'),
  endsAt: new Date('2026-06-30T23:59:59.999Z'),
};
const now = new Date('2026-06-15T00:00:00.000Z');

const campaign: Campaign = {
  currency: 'USD',
  schedule,
  suppression: 'highest-only',
  tiers: [
    {
      id: 'silver',
      threshold: money(5000, 'USD'),
      gift: { kind: 'AND', gifts: [{ variantId: 's' }] },
    },
    {
      id: 'gold',
      threshold: money(10000, 'USD'),
      gift: { kind: 'AND', gifts: [{ variantId: 'g' }] },
    },
  ],
};

const paid = (amountMinor: number): CartLine => ({
  variantId: 'paid',
  unitPrice: money(amountMinor, 'USD'),
  quantity: 1,
  isGift: false,
});

const input = (overrides: Partial<ResolveInput>): ResolveInput => ({
  campaign,
  cart: [paid(5000)],
  now,
  choices: {},
  declined: false,
  ...overrides,
});

describe('resolveActiveGifts — schedule gate', () => {
  it('returns inactive outside the campaign window', () => {
    const result = resolveActiveGifts(input({ now: new Date('2026-07-01T00:00:00.000Z') }));
    expect(result).toEqual({ status: 'inactive' });
  });
});

describe('resolveActiveGifts — qualification', () => {
  it('returns no-gift below the lowest threshold', () => {
    const result = resolveActiveGifts(input({ cart: [paid(4999)] }));
    expect(result).toEqual({
      status: 'no-gift',
      subtotal: money(4999, 'USD'),
      reason: 'below-threshold',
    });
  });

  it('resolves the silver gift at exactly the silver threshold', () => {
    const result = resolveActiveGifts(input({ cart: [paid(5000)] }));
    expect(result).toEqual({
      status: 'gifts',
      subtotal: money(5000, 'USD'),
      resolved: [{ tierId: 'silver', gifts: [{ variantId: 's' }] }],
    });
  });

  it('suppresses the lower tier under highest-only at the gold threshold', () => {
    const result = resolveActiveGifts(input({ cart: [paid(10000)] }));
    expect(result).toEqual({
      status: 'gifts',
      subtotal: money(10000, 'USD'),
      resolved: [{ tierId: 'gold', gifts: [{ variantId: 'g' }] }],
    });
  });

  it('returns every qualified tier under cumulative suppression', () => {
    const result = resolveActiveGifts(
      input({
        campaign: { ...campaign, suppression: 'cumulative' },
        cart: [paid(10000)],
      }),
    );
    expect(result).toEqual({
      status: 'gifts',
      subtotal: money(10000, 'USD'),
      resolved: [
        { tierId: 'silver', gifts: [{ variantId: 's' }] },
        { tierId: 'gold', gifts: [{ variantId: 'g' }] },
      ],
    });
  });
});

describe('resolveActiveGifts — gift never counts toward qualification', () => {
  it('does not let a gift line bump the cart into the next tier', () => {
    // Paid 5000 qualifies for silver. A gift worth 5000 sits in the cart but must be excluded,
    // so the cart stays at silver and never reaches the 10000 gold threshold.
    const giftLine: CartLine = {
      variantId: 's',
      unitPrice: money(5000, 'USD'),
      quantity: 1,
      isGift: true,
    };
    const result = resolveActiveGifts(input({ cart: [paid(5000), giftLine] }));
    expect(result).toEqual({
      status: 'gifts',
      subtotal: money(5000, 'USD'),
      resolved: [{ tierId: 'silver', gifts: [{ variantId: 's' }] }],
    });
  });
});

describe('resolveActiveGifts — decline', () => {
  it('declining removes the gift (no code to mint)', () => {
    const result = resolveActiveGifts(input({ cart: [paid(5000)], declined: true }));
    expect(result).toEqual({
      status: 'no-gift',
      subtotal: money(5000, 'USD'),
      reason: 'declined',
    });
  });

  it('re-accepting restores the gift', () => {
    const result = resolveActiveGifts(input({ cart: [paid(5000)], declined: false }));
    expect(result).toMatchObject({
      status: 'gifts',
      resolved: [{ tierId: 'silver', gifts: [{ variantId: 's' }] }],
    });
  });
});

describe('resolveActiveGifts — OR tiers', () => {
  const orCampaign: Campaign = {
    ...campaign,
    tiers: [
      {
        id: 'silver',
        threshold: money(5000, 'USD'),
        gift: {
          kind: 'OR',
          options: [
            { id: 'opt-a', variantId: 'a' },
            { id: 'opt-b', variantId: 'b' },
          ],
        },
      },
    ],
  };

  it('resolves the shopper choice deterministically', () => {
    const result = resolveActiveGifts(
      input({ campaign: orCampaign, choices: { silver: 'opt-b' } }),
    );
    expect(result).toMatchObject({
      status: 'gifts',
      resolved: [{ tierId: 'silver', gifts: [{ variantId: 'b' }] }],
    });
  });

  it('rejects a missing choice for an active OR tier', () => {
    expect(() => resolveActiveGifts(input({ campaign: orCampaign, choices: {} }))).toThrow(
      InvalidGiftChoiceError,
    );
  });
});
