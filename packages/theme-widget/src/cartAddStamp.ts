// Pure helpers for stamping `_fge_gift` on storefront cart/add.js payloads. Gift variants that belong
// to the active campaign must always land as marked app-added lines (separate from unmarked buys) so
// BXGY can allocate the $0 unit and /validate can exclude them from the qualifying subtotal. Without
// the marker, Shopify merges or splits lines and the free-gift discount never attaches — especially
// when the cart already exceeds the highest tier and the shopper adds the same variant again.
import { GIFT_LINE_PROPERTY, type CampaignConfigResponse } from '@free-gift-engine/core';

const toGid = (numericId: number): string => `gid://shopify/ProductVariant/${numericId}`;

export function allCampaignGiftVariantIds(
  config: CampaignConfigResponse | null,
): ReadonlySet<string> {
  if (config === null || config.status !== 'active') {
    return new Set();
  }
  const ids = new Set<string>();
  for (const tier of config.tiers) {
    if (tier.gift.kind === 'OR') {
      for (const option of tier.gift.options) {
        ids.add(option.variantId);
      }
    } else {
      for (const gift of tier.gift.gifts) {
        ids.add(gift.variantId);
      }
    }
  }
  return ids;
}

type CartAddItem = {
  id?: number;
  quantity?: number;
  properties?: Record<string, string>;
};

function stampItem(item: CartAddItem, stampVariants: ReadonlySet<string>): CartAddItem {
  if (item.id === undefined) {
    return item;
  }
  if (!stampVariants.has(toGid(item.id))) {
    return item;
  }
  if (item.properties?.[GIFT_LINE_PROPERTY] != null) {
    return item;
  }
  return {
    ...item,
    properties: { ...item.properties, [GIFT_LINE_PROPERTY]: '1' },
  };
}

// Mutate a cart/add.js JSON body in-place shape: returns a new object when stamping is needed.
export function stampGiftPropertiesOnAddBody(
  body: unknown,
  stampVariants: ReadonlySet<string>,
): unknown {
  if (stampVariants.size === 0 || body === null || typeof body !== 'object') {
    return body;
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record['items'])) {
    const items = record['items'] as CartAddItem[];
    const next = items.map((item) => stampItem(item, stampVariants));
    const changed = next.some((item, i) => item !== items[i]);
    return changed ? { ...record, items: next } : body;
  }
  if (typeof record['id'] === 'number') {
    const next = stampItem(record as CartAddItem, stampVariants);
    return next === record ? body : next;
  }
  return body;
}
