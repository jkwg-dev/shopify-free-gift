import { money } from '@free-gift-engine/core';
import type {
  GiftChannelAvailability,
  VariantMeta,
  VariantPricing,
} from '@free-gift-engine/shopify';
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../domain.js';
import { type ActiveCampaignContext } from './service.js';
import { type ConfigServiceDeps, resolveCampaignConfig } from './configService.js';

const ICE = 'gid://shopify/ProductVariant/Ice';
const DAWN = 'gid://shopify/ProductVariant/Dawn';
const HIDDEN = 'gid://shopify/ProductVariant/Hidden';
const SNOWBOARD = 'gid://shopify/Product/Complete';
const HIDDEN_P = 'gid://shopify/Product/Hidden';

// tier 1 = OR (Ice/Dawn, siblings of one product); tier 2 = AND (single Hidden).
const campaign: Campaign = {
  id: 'camp1',
  shopId: 'shop1',
  name: 'Summer',
  suppression: 'highest-only',
  declineEnabled: true,
  startsAt: new Date('2026-06-01T00:00:00Z'),
  endsAt: new Date('2026-07-01T00:00:00Z'),
  displayTimezone: 'UTC',
  active: true,
  configVersionHash: 'cfg-1',
  qualifyingCollectionId: 'gid://shopify/Collection/q',
  tiers: [
    {
      id: 't1',
      campaignId: 'camp1',
      position: 1,
      baseThreshold: money(5000, 'USD'),
      gift: {
        kind: 'OR',
        options: [
          { id: 'a', variantId: ICE },
          { id: 'b', variantId: DAWN },
        ],
      },
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
      gift: { kind: 'AND', gifts: [{ variantId: HIDDEN }] },
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

const meta: readonly VariantMeta[] = [
  {
    id: ICE,
    productId: SNOWBOARD,
    productTitle: 'The Complete Snowboard',
    variantTitle: 'Ice',
    imageUrl: 'https://cdn/ice.jpg',
  },
  {
    id: DAWN,
    productId: SNOWBOARD,
    productTitle: 'The Complete Snowboard',
    variantTitle: 'Dawn',
    imageUrl: 'https://cdn/dawn.jpg',
  },
  // single-variant product -> 'Default Title' sentinel; label should fall back to the product name.
  {
    id: HIDDEN,
    productId: HIDDEN_P,
    productTitle: 'The Hidden Snowboard',
    variantTitle: 'Default Title',
    imageUrl: null,
  },
];

const pricing: readonly VariantPricing[] = [
  {
    id: ICE,
    productId: SNOWBOARD,
    availableForSale: true,
    price: { amount: '699.95', currencyCode: 'USD' },
  },
  {
    id: DAWN,
    productId: SNOWBOARD,
    availableForSale: true,
    price: { amount: '699.95', currencyCode: 'USD' },
  },
  {
    id: HIDDEN,
    productId: HIDDEN_P,
    availableForSale: true,
    price: { amount: '749.95', currencyCode: 'USD' },
  },
];

// Channel availability (Stage E): the SINGLE source of stock + Online-Store publish on the gift path.
// Dawn is out of stock; everything is published. The predicate combines this with pricing presence +
// meta resolution, so it is what now drives each option's `available` flag.
const channel: ReadonlyMap<string, GiftChannelAvailability> = new Map([
  [ICE, { availableForSale: true, publishedToOnlineStore: true }],
  [DAWN, { availableForSale: false, publishedToOnlineStore: true }], // OOS
  [HIDDEN, { availableForSale: true, publishedToOnlineStore: true }],
]);

function deps(
  context: ActiveCampaignContext | null,
  over: Partial<ConfigServiceDeps> = {},
): ConfigServiceDeps {
  return {
    resolveActiveCampaign: () => Promise.resolve(context),
    priceVariants: () => Promise.resolve(pricing),
    fetchVariantMeta: () => Promise.resolve(meta),
    fetchChannelAvailability: () => Promise.resolve(channel),
    ...over,
  };
}

const ctx: ActiveCampaignContext = { shopId: 'shop1', baseCurrency: 'USD', campaign };

describe('resolveCampaignConfig', () => {
  it('returns inactive when there is no live campaign', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'USD', countryCode: 'US' },
      deps(null),
    );
    expect(res).toEqual({ status: 'inactive' });
  });

  it('builds the active structure: OR options grouped-ready, AND items, presentment thresholds', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'USD', countryCode: 'US' },
      deps(ctx),
    );
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;

    expect(res.currency).toBe('USD');
    expect(res.declineEnabled).toBe(true);
    expect(res.tiers).toHaveLength(2);

    const [t1, t2] = res.tiers;
    // base-currency buyer -> threshold is the base threshold (the figure /validate also enforces).
    expect(t1!.threshold).toEqual(money(5000, 'USD'));
    expect(t1!.gift.kind).toBe('OR');
    if (t1!.gift.kind !== 'OR') return;
    expect(t1!.gift.options).toEqual([
      {
        optionId: 'a',
        variantId: ICE,
        productId: SNOWBOARD,
        productLabel: 'The Complete Snowboard',
        variantLabel: 'Ice',
        available: true,
        imageUrl: 'https://cdn/ice.jpg',
      },
      {
        optionId: 'b',
        variantId: DAWN,
        productId: SNOWBOARD,
        productLabel: 'The Complete Snowboard',
        variantLabel: 'Dawn',
        available: false,
        imageUrl: 'https://cdn/dawn.jpg',
      }, // OOS
    ]);

    expect(t2!.gift.kind).toBe('AND');
    if (t2!.gift.kind !== 'AND') return;
    // single-variant product -> label falls back to the product title.
    expect(t2!.gift.gifts).toEqual([
      {
        variantId: HIDDEN,
        productId: HIDDEN_P,
        productLabel: 'The Hidden Snowboard',
        variantLabel: 'The Hidden Snowboard',
        available: true,
        imageUrl: null,
      },
    ]);
  });

  it('derives presentment thresholds from the rate (== what /validate enforces)', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'CAD', countryCode: 'CA', presentmentRate: '1.4' },
      deps(ctx),
    );
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    expect(res.tiers[0]!.threshold).toEqual(money(7000, 'CAD')); // ceil(5000 x 1.4)
    expect(res.tiers[1]!.threshold).toEqual(money(14000, 'CAD')); // ceil(10000 x 1.4)
  });

  it('derives ZERO-DECIMAL (JPY) thresholds through the full config path (exponent shift)', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'JPY', countryCode: 'JP', presentmentRate: '110.567' },
      deps(ctx),
    );
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    // ceil($50.00 x 110.567) = ceil(5528.35) = JPY 5529 ; ceil($100.00 x 110.567) = JPY 11057
    expect(res.tiers[0]!.threshold).toEqual(money(5529, 'JPY'));
    expect(res.tiers[1]!.threshold).toEqual(money(11057, 'JPY'));
  });

  it('returns inactive in a non-base market with no rate (campaign not offerable there)', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'EUR', countryCode: 'FR' },
      deps(ctx),
    );
    expect(res).toEqual({ status: 'inactive' });
  });

  it('marks a gift unavailable when it does not resolve (deleted variant)', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'USD', countryCode: 'US' },
      deps(ctx, { fetchVariantMeta: () => Promise.resolve(meta.filter((m) => m.id !== ICE)) }),
    );
    if (res.status !== 'active' || res.tiers[0]!.gift.kind !== 'OR')
      throw new Error('expected active OR');
    const ice = res.tiers[0]!.gift.options.find((o) => o.variantId === ICE)!;
    expect(ice.available).toBe(false);
    expect(ice.variantLabel).toBe(ICE); // fallback label when meta is missing
  });

  it('renders the config with gifts greyed (never 500s) when the channel lookup THROWS', async () => {
    // Regression: an unpublished gift made the channel fetch throw, 500ing /config so the widget
    // rendered NOTHING. It must fail closed — return the structure with every gift not-available.
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'USD', countryCode: 'US' },
      deps(ctx, { fetchChannelAvailability: () => Promise.reject(new Error('channel boom')) }),
    );
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    const t1 = res.tiers[0]!;
    if (t1.gift.kind !== 'OR') throw new Error('expected OR');
    expect(t1.gift.options.every((o) => !o.available)).toBe(true); // greyed, not thrown
    const t2 = res.tiers[1]!;
    if (t2.gift.kind !== 'AND') throw new Error('expected AND');
    expect(t2.gift.gifts.every((g) => !g.available)).toBe(true);
  });

  it('marks an in-stock gift unavailable when it is NOT published to the Online Store (the 422 leak)', async () => {
    // Ice is priced + in stock + resolved but its product is not on the Online Store. Pre-Stage-E it
    // would have been offered (available:true) and 422'd at /cart/add; now it is proactively disabled.
    const unpublished: ReadonlyMap<string, GiftChannelAvailability> = new Map([
      [ICE, { availableForSale: true, publishedToOnlineStore: false }],
      [DAWN, { availableForSale: true, publishedToOnlineStore: true }],
      [HIDDEN, { availableForSale: true, publishedToOnlineStore: true }],
    ]);
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'USD', countryCode: 'US' },
      deps(ctx, { fetchChannelAvailability: () => Promise.resolve(unpublished) }),
    );
    if (res.status !== 'active' || res.tiers[0]!.gift.kind !== 'OR')
      throw new Error('expected active OR');
    const ice = res.tiers[0]!.gift.options.find((o) => o.variantId === ICE)!;
    expect(ice.available).toBe(false);
    const dawn = res.tiers[0]!.gift.options.find((o) => o.variantId === DAWN)!;
    expect(dawn.available).toBe(true); // published + in stock here
  });
});
