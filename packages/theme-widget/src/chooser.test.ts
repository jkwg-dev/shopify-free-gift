import { money, type CampaignConfigResponse } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { buildChooserModel, type ChooserAndTier, type ChooserOrTier } from './chooser.js';

const ICE = 'gid://shopify/ProductVariant/Ice';
const DAWN = 'gid://shopify/ProductVariant/Dawn';
const HIDDEN = 'gid://shopify/ProductVariant/Hidden';
const MULTI = 'gid://shopify/ProductVariant/Multi';
const LIQUID_S = 'gid://shopify/ProductVariant/S';
const SNOWBOARD = 'gid://shopify/Product/Complete';

// Mirrors the real campaign: tier 1 OR (Ice/Dawn), tier 2 AND (Hidden + Multi-location), tier 3 OR.
const config: CampaignConfigResponse = {
  status: 'active',
  currency: 'USD',
  declineEnabled: true,
  tiers: [
    {
      tierId: 't1',
      position: 1,
      threshold: money(50000, 'USD'),
      gift: {
        kind: 'OR',
        options: [
          {
            optionId: 'a',
            variantId: ICE,
            productId: SNOWBOARD,
            productLabel: 'The Complete Snowboard',
            variantLabel: 'Ice',
            available: true,
          },
          {
            optionId: 'b',
            variantId: DAWN,
            productId: SNOWBOARD,
            productLabel: 'The Complete Snowboard',
            variantLabel: 'Dawn',
            available: true,
          },
        ],
      },
    },
    {
      tierId: 't2',
      position: 2,
      threshold: money(100000, 'USD'),
      gift: {
        kind: 'AND',
        gifts: [
          {
            variantId: HIDDEN,
            productId: 'gid://shopify/Product/Hidden',
            variantLabel: 'The Hidden Snowboard',
            available: true,
          },
          {
            variantId: MULTI,
            productId: 'gid://shopify/Product/Multi',
            variantLabel: 'The Multi-location Snowboard',
            available: true,
          },
        ],
      },
    },
    {
      tierId: 't3',
      position: 3,
      threshold: money(150000, 'USD'),
      gift: {
        kind: 'OR',
        options: [
          {
            optionId: 'opt-1',
            variantId: LIQUID_S,
            productId: 'gid://shopify/Product/Liquid',
            variantLabel: 'S',
            available: true,
          },
        ],
      },
    },
  ],
};

describe('buildChooserModel', () => {
  it('returns null for an inactive campaign', () => {
    expect(buildChooserModel({ status: 'inactive' }, { choices: {}, declined: false })).toBeNull();
  });

  it('represents ALL tiers in order — OR, AND, OR (the AND tier is not dropped)', () => {
    const model = buildChooserModel(config, { choices: { t1: 'a' }, declined: false });
    expect(model).not.toBeNull();
    expect(model!.tiers.map((t) => t.kind)).toEqual(['or', 'and', 'or']);
    expect(model!.declineEnabled).toBe(true);
  });

  it('renders the AND tier as a bundled display: both gifts, NO radios/choice', () => {
    const model = buildChooserModel(config, { choices: {}, declined: false });
    const and = model!.tiers[1] as ChooserAndTier;
    expect(and.kind).toBe('and');
    expect(and.items.map((i) => i.variantLabel)).toEqual([
      'The Hidden Snowboard',
      'The Multi-location Snowboard',
    ]);
    // An AND tier carries NO selectable options/groups and NO selection — nothing feeds `choices`.
    expect('groups' in and).toBe(false);
    expect('selected' in and).toBe(false);
    expect(and.threshold).toEqual(money(100000, 'USD'));
  });

  it('keeps OR tiers as grouped, selectable options with the current selection', () => {
    const model = buildChooserModel(config, { choices: { t1: 'b' }, declined: false });
    const or = model!.tiers[0] as ChooserOrTier;
    expect(or.kind).toBe('or');
    expect(or.selected).toBe('b');
    // Ice + Dawn are siblings of one product -> a single group with two options (ONE product card
    // with an inner variant picker), carrying the product title for the card heading.
    expect(or.groups).toHaveLength(1);
    expect(or.groups[0]!.options.map((o) => o.variantLabel)).toEqual(['Ice', 'Dawn']);
    expect(or.groups[0]!.options[0]!.productLabel).toBe('The Complete Snowboard');
  });
});

describe('buildChooserModel — runtime unavailability (422 fallback)', () => {
  it('disables an OR option whose variant failed at runtime (config available, but in the set)', () => {
    const model = buildChooserModel(config, {
      choices: { t1: 'a' },
      declined: false,
      unavailableVariantIds: new Set([DAWN]),
    });
    const or = model!.tiers[0] as ChooserOrTier;
    const opts = or.groups.flatMap((g) => g.options);
    expect(opts.find((o) => o.variantId === ICE)!.available).toBe(true);
    expect(opts.find((o) => o.variantId === DAWN)!.available).toBe(false); // runtime-disabled
  });

  it('marks an AND tier INCOMPLETE when one bundle item failed at runtime', () => {
    const model = buildChooserModel(config, {
      choices: {},
      declined: false,
      unavailableVariantIds: new Set([HIDDEN]),
    });
    const and = model!.tiers[1] as ChooserAndTier;
    expect(and.incomplete).toBe(true);
    expect(and.items.find((i) => i.variantId === HIDDEN)!.available).toBe(false);
    expect(and.items.find((i) => i.variantId === MULTI)!.available).toBe(true);
  });

  it('AND tier is NOT incomplete when all items are available', () => {
    const model = buildChooserModel(config, { choices: {}, declined: false });
    const and = model!.tiers[1] as ChooserAndTier;
    expect(and.incomplete).toBe(false);
  });
});
