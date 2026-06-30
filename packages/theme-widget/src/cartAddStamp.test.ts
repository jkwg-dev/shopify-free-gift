import { describe, expect, it } from 'vitest';
import { GIFT_LINE_PROPERTY, money, type CampaignConfigResponse } from '@free-gift-engine/core';
import { allCampaignGiftVariantIds, stampGiftPropertiesOnAddBody } from './cartAddStamp.js';

const HAT = 'gid://shopify/ProductVariant/100';
const TEE = 'gid://shopify/ProductVariant/200';

const config: CampaignConfigResponse = {
  status: 'active',
  currency: 'CAD',
  declineEnabled: true,
  tiers: [
    {
      tierId: 't1',
      position: 1,
      threshold: money(50000, 'CAD'),
      gift: {
        kind: 'OR',
        options: [
          {
            optionId: 'a',
            variantId: HAT,
            productId: 'gid://shopify/Product/1',
            variantLabel: 'Default',
            available: true,
          },
        ],
      },
    },
    {
      tierId: 't2',
      position: 2,
      threshold: money(100000, 'CAD'),
      gift: {
        kind: 'AND',
        gifts: [
          {
            variantId: TEE,
            productId: 'gid://shopify/Product/2',
            variantLabel: 'S',
            available: true,
          },
        ],
      },
    },
  ],
};

describe('allCampaignGiftVariantIds', () => {
  it('collects every OR and AND gift variant from an active config', () => {
    expect(allCampaignGiftVariantIds(config)).toEqual(new Set([HAT, TEE]));
  });

  it('returns empty for inactive or null config', () => {
    expect(allCampaignGiftVariantIds(null)).toEqual(new Set());
    expect(allCampaignGiftVariantIds({ status: 'inactive' })).toEqual(new Set());
  });
});

describe('stampGiftPropertiesOnAddBody', () => {
  const stamp = allCampaignGiftVariantIds(config);

  it('stamps _fge_gift on batched items[] adds for campaign gift variants', () => {
    const body = {
      items: [
        { id: 100, quantity: 1 },
        { id: 300, quantity: 2 },
      ],
    };
    expect(stampGiftPropertiesOnAddBody(body, stamp)).toEqual({
      items: [
        { id: 100, quantity: 1, properties: { [GIFT_LINE_PROPERTY]: '1' } },
        { id: 300, quantity: 2 },
      ],
    });
  });

  it('stamps legacy single-item cart/add bodies', () => {
    expect(stampGiftPropertiesOnAddBody({ id: 200, quantity: 1 }, stamp)).toEqual({
      id: 200,
      quantity: 1,
      properties: { [GIFT_LINE_PROPERTY]: '1' },
    });
  });

  it('does not overwrite an existing _fge_gift property', () => {
    const body = {
      items: [{ id: 100, quantity: 1, properties: { [GIFT_LINE_PROPERTY]: '1', note: 'x' } }],
    };
    expect(stampGiftPropertiesOnAddBody(body, stamp)).toBe(body);
  });

  it('returns the original body when nothing matches', () => {
    const body = { items: [{ id: 999, quantity: 1 }] };
    expect(stampGiftPropertiesOnAddBody(body, stamp)).toBe(body);
  });
});
