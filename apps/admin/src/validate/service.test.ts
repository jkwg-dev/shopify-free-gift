import { InvalidGiftChoiceError, money, type SuppressionMode } from '@free-gift-engine/core';
import type { VariantPricing } from '@free-gift-engine/shopify';
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../domain.js';
import { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import { FakeDiscountGateway, FakeMappingTable } from '../testing/fakes.js';
import type { ValidateRequest } from './contract.js';
import { resolveValidate, ValidateBadRequestError, type ValidateServiceDeps } from './service.js';

const P1 = 'gid://shopify/ProductVariant/P1';
const G1 = 'gid://shopify/ProductVariant/G1';
const G2 = 'gid://shopify/ProductVariant/G2';
const NOW = new Date('2026-06-25T12:00:00Z');

// country -> variantId -> price/availability
type PriceTable = Record<
  string,
  Record<string, { amount: string; currencyCode: string; availableForSale?: boolean }>
>;

const DEFAULT_PRICES: PriceTable = {
  US: {
    [P1]: { amount: '60.00', currencyCode: 'USD' },
    [G1]: { amount: '20.00', currencyCode: 'USD' },
    [G2]: { amount: '30.00', currencyCode: 'USD' },
  },
  CA: {
    [P1]: { amount: '80.00', currencyCode: 'CAD' },
    [G1]: { amount: '28.00', currencyCode: 'CAD' },
    [G2]: { amount: '42.00', currencyCode: 'CAD' },
  },
};

function makePricer(table: PriceTable) {
  return (variantIds: readonly string[], ctx: { country: string }): Promise<VariantPricing[]> => {
    const byVariant = table[ctx.country] ?? {};
    const out = variantIds.flatMap((id): VariantPricing[] => {
      const p = byVariant[id];
      return p === undefined
        ? []
        : [
            {
              id,
              availableForSale: p.availableForSale ?? true,
              price: { amount: p.amount, currencyCode: p.currencyCode },
            },
          ];
    });
    return Promise.resolve(out);
  };
}

function campaignWith(
  suppression: SuppressionMode,
  tier1Gift: Campaign['tiers'][number]['gift'],
): Campaign {
  return {
    id: 'camp1',
    shopId: 'shop1',
    name: 'Summer',
    suppression,
    declineEnabled: true,
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-07-01T00:00:00Z'),
    displayTimezone: 'UTC',
    active: true,
    configVersionHash: 'cfg-hash-1',
    tiers: [
      {
        id: 't1',
        campaignId: 'camp1',
        position: 1,
        baseThreshold: money(5000, 'USD'),
        gift: tier1Gift,
        marketThresholds: [
          {
            id: 'm1',
            tierId: 't1',
            market: 'ca',
            presentmentCurrency: 'CAD',
            manualFxRate: 1.4,
            roundingRule: 'none',
            resolvedThreshold: money(7000, 'CAD'),
          },
        ],
      },
      {
        id: 't2',
        campaignId: 'camp1',
        position: 2,
        baseThreshold: money(10000, 'USD'),
        gift: { kind: 'AND', gifts: [{ variantId: G2 }] },
        marketThresholds: [
          {
            id: 'm2',
            tierId: 't2',
            market: 'ca',
            presentmentCurrency: 'CAD',
            manualFxRate: 1.4,
            roundingRule: 'none',
            resolvedThreshold: money(14000, 'CAD'),
          },
        ],
      },
    ],
  };
}

const DEFAULT_CAMPAIGN = campaignWith('highest-only', { kind: 'AND', gifts: [{ variantId: G1 }] });

function makeDeps(
  options: {
    campaign?: Campaign | null;
    prices?: PriceTable;
    now?: () => Date;
    failMint?: boolean;
  } = {},
): { deps: ValidateServiceDeps; gateway: FakeDiscountGateway } {
  const gateway = options.failMint
    ? new FakeDiscountGateway({ failWith: new Error('mint boom') })
    : new FakeDiscountGateway();
  const store = new GiftCodeMappingStore(new FakeMappingTable(), gateway, {
    sleep: () => Promise.resolve(),
  });
  const campaign = options.campaign === undefined ? DEFAULT_CAMPAIGN : options.campaign;
  const deps: ValidateServiceDeps = {
    resolveActiveCampaign: () =>
      Promise.resolve(
        campaign === null ? null : { shopId: 'shop1', baseCurrency: 'USD', campaign },
      ),
    priceVariants: makePricer(options.prices ?? DEFAULT_PRICES),
    mappingStore: store,
    qualifyingCollectionId: 'gid://shopify/Collection/test',
    now: options.now ?? (() => NOW),
  };
  return { deps, gateway };
}

function req(overrides: Partial<ValidateRequest> = {}): ValidateRequest {
  return {
    cart: [],
    choices: {},
    declined: false,
    presentmentCurrency: 'USD',
    countryCode: 'US',
    ...overrides,
  };
}

describe('resolveValidate — suppression', () => {
  it('returns only the highest qualified tier under highest-only', async () => {
    const { deps, gateway } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }), // $120 -> both tiers
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.subtotal).toEqual(money(12000, 'USD'));
    expect(result.tierId).toBe('t2');
    expect(result.giftVariantIds).toEqual([G2]);
    expect(result.appliedThreshold).toEqual(money(10000, 'USD'));
    expect(result.code.length).toBeGreaterThan(0);
    expect(gateway.createCount).toBe(1);
  });

  it('refuses a cumulative campaign that resolves multiple tiers (unsupported on Advanced)', async () => {
    const { deps, gateway } = makeDeps({
      campaign: campaignWith('cumulative', { kind: 'AND', gifts: [{ variantId: G1 }] }),
    });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }), // qualifies both tiers
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'cumulative-unsupported',
      subtotal: money(12000, 'USD'),
    });
    expect(gateway.createCount).toBe(0); // never mint codes that cannot all redeem
  });
});

describe('resolveValidate — server-authoritative cart', () => {
  it('excludes app-added gift lines from the subtotal (isGift is server-derived)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: G1, quantity: 3, appAdded: true }] }), // all excluded -> $0
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'below-threshold',
      subtotal: money(0, 'USD'), // all lines are app-added gifts -> excluded
    });
  });

  it('counts a paid duplicate of a gift-eligible product (exclusion is per-line)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [
          { variantId: G1, quantity: 1, appAdded: true }, // gift line, excluded
          { variantId: G1, quantity: 3, appAdded: false }, // separately purchased: 3 x $20 = $60
        ],
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.subtotal).toEqual(money(6000, 'USD'));
    expect(result.tierId).toBe('t1');
  });

  it('ignores unpriceable phantom lines so the client cannot inflate the tier', async () => {
    // The server prices from Shopify, never the client; an unknown variant contributes nothing.
    // The discount's base-currency minimum remains the authoritative checkout backstop.
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [
          { variantId: P1, quantity: 1, appAdded: false }, // $60
          { variantId: 'gid://shopify/ProductVariant/PHANTOM', quantity: 50, appAdded: false },
        ],
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.subtotal).toEqual(money(6000, 'USD'));
    expect(result.tierId).toBe('t1'); // not t2, despite 50 phantom units
  });
});

describe('resolveValidate — OR choice', () => {
  const orCampaign = campaignWith('highest-only', {
    kind: 'OR',
    options: [
      { id: 'a', variantId: G1 },
      { id: 'b', variantId: G2 },
    ],
  });

  it('resolves the chosen option to exactly one gift', async () => {
    const { deps } = makeDeps({ campaign: orCampaign });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 1, appAdded: false }], choices: { t1: 'b' } }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.giftVariantIds).toEqual([G2]);
  });

  it('rejects a missing OR choice instead of defaulting', async () => {
    const { deps } = makeDeps({ campaign: orCampaign });
    await expect(
      resolveValidate(
        'shop.myshopify.com',
        req({ cart: [{ variantId: P1, quantity: 1, appAdded: false }], choices: {} }),
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidGiftChoiceError);
  });

  it('mints distinct codes for sibling-variant OR choices (variant-granular minting key)', async () => {
    // G1 and G2 stand in for two variants of ONE product. Core has no productId, so the options
    // never collapse: each resolved variant keys its own scoped code.
    const { deps, gateway } = makeDeps({ campaign: orCampaign });
    const cart = [{ variantId: P1, quantity: 1, appAdded: false }];
    const a = await resolveValidate('s.myshopify.com', req({ cart, choices: { t1: 'a' } }), deps);
    const b = await resolveValidate('s.myshopify.com', req({ cart, choices: { t1: 'b' } }), deps);

    expect(a.status).toBe('gift');
    expect(b.status).toBe('gift');
    if (a.status !== 'gift' || b.status !== 'gift') return;
    expect(a.giftVariantIds).toEqual([G1]);
    expect(b.giftVariantIds).toEqual([G2]);
    expect(a.code).not.toBe(b.code);
    expect(gateway.createCount).toBe(2);
  });
});

describe('resolveValidate — markets (FX-derived thresholds)', () => {
  it('derives the presentment threshold from the Shopify rate (base USD x rate)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // $80 CAD
        presentmentCurrency: 'CAD',
        countryCode: 'CA',
        presentmentRate: '1.4', // base $50.00 x 1.4 -> CA$70.00
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.currency).toBe('CAD');
    expect(result.subtotal).toEqual(money(8000, 'CAD'));
    expect(result.tierId).toBe('t1');
    expect(result.appliedThreshold).toEqual(money(7000, 'CAD')); // ceil(5000 x 1.4), not base USD
  });

  it('IGNORES stored marketThresholds rows — derives purely from the rate', async () => {
    // The fixture's t1 stores resolvedThreshold CA$70.00 (rate 1.4). A different rate must produce a
    // different threshold, proving the stored row is not consulted.
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // $80 CAD
        presentmentCurrency: 'CAD',
        countryCode: 'CA',
        presentmentRate: '1.5', // ceil(5000 x 1.5) = CA$75.00, NOT the stored CA$70.00
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.appliedThreshold).toEqual(money(7500, 'CAD'));
  });

  it('rejects when the claimed currency does not match the country pricing', async () => {
    // With a rate the CAD thresholds resolve, but country US prices come back in USD — the claimed
    // presentment currency is inconsistent with the authoritative country pricing.
    const { deps } = makeDeps();
    await expect(
      resolveValidate(
        'shop.myshopify.com',
        req({
          cart: [{ variantId: P1, quantity: 1, appAdded: false }],
          presentmentCurrency: 'CAD',
          countryCode: 'US', // priced in USD
          presentmentRate: '1.4',
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidateBadRequestError);
  });

  it('returns inactive in a non-base market with NO rate (cannot price against the floor)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 2, appAdded: false }],
        presentmentCurrency: 'GBP',
        countryCode: 'GB', // no presentmentRate
      }),
      deps,
    );

    expect(result).toEqual({ status: 'no-gift', reason: 'inactive' });
  });

  it('returns inactive in a non-base market when the rate is invalid (<= 0)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 2, appAdded: false }],
        presentmentCurrency: 'CAD',
        countryCode: 'CA',
        presentmentRate: '0', // invalid -> parsePresentmentRate null -> no threshold -> inactive
      }),
      deps,
    );

    expect(result).toEqual({ status: 'no-gift', reason: 'inactive' });
  });

  it('derives a ZERO-DECIMAL (JPY) threshold end-to-end (exponent shift, no x100 error)', async () => {
    // The whole reason zero-decimal currencies are dangerous: base USD (exp 2) -> JPY (exp 0) exercises
    // the shift = -2 branch through the FULL path (rate parse -> derive -> JPY-priced cart -> compare).
    const prices: PriceTable = {
      JP: {
        [P1]: { amount: '8000', currencyCode: 'JPY' }, // whole yen, no decimals
        [G1]: { amount: '3000', currencyCode: 'JPY' },
        [G2]: { amount: '4500', currencyCode: 'JPY' },
      },
    };
    const { deps } = makeDeps({ prices });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // JPY 8000
        presentmentCurrency: 'JPY',
        countryCode: 'JP',
        presentmentRate: '110.567',
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.currency).toBe('JPY');
    expect(result.subtotal).toEqual(money(8000, 'JPY')); // integer yen
    expect(result.tierId).toBe('t1'); // 8000 >= 5529 (t1) but < 11057 (t2)
    // ceil($50.00 x 110.567) = ceil(5528.35) = JPY 5529 — NOT 552835 (missing shift) nor 55 (wrong way)
    expect(result.appliedThreshold).toEqual(money(5529, 'JPY'));
  });

  it('qualifies a cart EXACTLY at the derived threshold (inclusive boundary)', async () => {
    const prices: PriceTable = {
      CA: {
        [P1]: { amount: '70.00', currencyCode: 'CAD' },
        [G1]: { amount: '28.00', currencyCode: 'CAD' },
      },
    };
    const { deps } = makeDeps({ prices });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // exactly CA$70.00 = 7000 minor
        presentmentCurrency: 'CAD',
        countryCode: 'CA',
        presentmentRate: '1.4', // derived t1 = ceil(5000 x 1.4) = 7000
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.subtotal).toEqual(money(7000, 'CAD'));
    expect(result.tierId).toBe('t1');
    expect(result.appliedThreshold).toEqual(money(7000, 'CAD'));
  });

  it('does NOT qualify one minor unit below the derived threshold', async () => {
    const prices: PriceTable = {
      CA: {
        [P1]: { amount: '69.99', currencyCode: 'CAD' },
        [G1]: { amount: '28.00', currencyCode: 'CAD' },
      },
    };
    const { deps } = makeDeps({ prices });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // CA$69.99 = 6999, one below 7000
        presentmentCurrency: 'CAD',
        countryCode: 'CA',
        presentmentRate: '1.4',
      }),
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'below-threshold',
      subtotal: money(6999, 'CAD'),
    });
  });

  it('IGNORES the rate entirely in the base currency (presentment === base)', async () => {
    const { deps } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({
        cart: [{ variantId: P1, quantity: 1, appAdded: false }], // $60 USD
        presentmentCurrency: 'USD',
        countryCode: 'US',
        presentmentRate: '2.5', // absurd; if (wrongly) applied -> threshold 12500 -> no gift
      }),
      deps,
    );

    expect(result.status).toBe('gift');
    if (result.status !== 'gift') return;
    expect(result.tierId).toBe('t1');
    expect(result.appliedThreshold).toEqual(money(5000, 'USD')); // base, NOT ceil(5000 x 2.5)
  });
});

describe('resolveValidate — no-gift paths', () => {
  it('does not promise an out-of-stock gift', async () => {
    const prices: PriceTable = {
      US: {
        [P1]: { amount: '60.00', currencyCode: 'USD' },
        [G1]: { amount: '20.00', currencyCode: 'USD' },
        [G2]: { amount: '30.00', currencyCode: 'USD', availableForSale: false },
      },
    };
    const { deps } = makeDeps({ prices });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }), // $120 -> t2 (G2)
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'gift-unavailable',
      subtotal: money(12000, 'USD'),
    });
  });

  it('degrades to no-gift (never throws -> never 500s the storefront) when minting fails', async () => {
    const { deps } = makeDeps({ failMint: true });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }), // $120 -> qualifies t2
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'gift-unavailable',
      subtotal: money(12000, 'USD'),
    });
  });

  it('resolves to no-gift when the shopper declines', async () => {
    const { deps, gateway } = makeDeps();
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }], declined: true }),
      deps,
    );

    expect(result).toEqual({
      status: 'no-gift',
      reason: 'declined',
      subtotal: money(12000, 'USD'), // declined but the subtotal is still reported for the fill
    });
    expect(gateway.createCount).toBe(0); // declined never mints
  });

  it('returns inactive when no campaign is live', async () => {
    const { deps } = makeDeps({ campaign: null });
    const result = await resolveValidate('shop.myshopify.com', req(), deps);
    expect(result).toEqual({ status: 'no-gift', reason: 'inactive' });
  });

  it('returns inactive outside the schedule window', async () => {
    const { deps } = makeDeps({ now: () => new Date('2026-08-01T00:00:00Z') });
    const result = await resolveValidate(
      'shop.myshopify.com',
      req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }),
      deps,
    );
    expect(result).toEqual({ status: 'no-gift', reason: 'inactive' });
  });
});

describe('resolveValidate — concurrency', () => {
  it('mints exactly one discount for two simultaneous qualifying calls (same code)', async () => {
    const { deps, gateway } = makeDeps();
    const call = () =>
      resolveValidate(
        'shop.myshopify.com',
        req({ cart: [{ variantId: P1, quantity: 2, appAdded: false }] }), // both -> t2
        deps,
      );

    const [a, b] = await Promise.all([call(), call()]);

    expect(gateway.createCount).toBe(1);
    expect(a.status).toBe('gift');
    expect(b.status).toBe('gift');
    if (a.status !== 'gift' || b.status !== 'gift') return;
    expect(a.code).toBe(b.code);
  });
});
