import { money } from '@free-gift-engine/core';
import type { VariantMeta, VariantPricing } from '@free-gift-engine/shopify';
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
  { id: ICE, productId: SNOWBOARD, productTitle: 'The Complete Snowboard', variantTitle: 'Ice' },
  { id: DAWN, productId: SNOWBOARD, productTitle: 'The Complete Snowboard', variantTitle: 'Dawn' },
  // single-variant product -> 'Default Title' sentinel; label should fall back to the product name.
  {
    id: HIDDEN,
    productId: HIDDEN_P,
    productTitle: 'The Hidden Snowboard',
    variantTitle: 'Default Title',
  },
];

// Dawn is out of stock.
const pricing: readonly VariantPricing[] = [
  { id: ICE, availableForSale: true, price: { amount: '699.95', currencyCode: 'USD' } },
  { id: DAWN, availableForSale: false, price: { amount: '699.95', currencyCode: 'USD' } },
  { id: HIDDEN, availableForSale: true, price: { amount: '749.95', currencyCode: 'USD' } },
];

function deps(
  context: ActiveCampaignContext | null,
  over: Partial<ConfigServiceDeps> = {},
): ConfigServiceDeps {
  return {
    resolveActiveCampaign: () => Promise.resolve(context),
    priceVariants: () => Promise.resolve(pricing),
    fetchVariantMeta: () => Promise.resolve(meta),
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
      { optionId: 'a', variantId: ICE, productId: SNOWBOARD, variantLabel: 'Ice', available: true },
      {
        optionId: 'b',
        variantId: DAWN,
        productId: SNOWBOARD,
        variantLabel: 'Dawn',
        available: false,
      }, // OOS
    ]);

    expect(t2!.gift.kind).toBe('AND');
    if (t2!.gift.kind !== 'AND') return;
    // single-variant product -> label falls back to the product title.
    expect(t2!.gift.gifts).toEqual([
      {
        variantId: HIDDEN,
        productId: HIDDEN_P,
        variantLabel: 'The Hidden Snowboard',
        available: true,
      },
    ]);
  });

  it('resolves presentment thresholds for a non-base market', async () => {
    const res = await resolveCampaignConfig(
      's.myshopify.com',
      { presentmentCurrency: 'CAD', countryCode: 'CA' },
      deps(ctx),
    );
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    expect(res.tiers[0]!.threshold).toEqual(money(7000, 'CAD'));
    expect(res.tiers[1]!.threshold).toEqual(money(14000, 'CAD'));
  });

  it('returns inactive when a market lacks a configured threshold (campaign not sold there)', async () => {
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
});
