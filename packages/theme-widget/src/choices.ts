// Pure grouping helper for the OR chooser (Phase 5a defines it; 5b renders it). The GiftOptionView
// type now lives in core (the campaign-config contract home) and is re-exported here so the widget
// keeps a single import surface. Grouping is for PRESENTATION only and must preserve every variant
// as its own selectable option — the reconciler keys on variant GID and never dedups by product.
import type { GiftItemView, GiftOptionView, TierConfig } from '@free-gift-engine/core';

export type { GiftItemView, GiftOptionView };

export type GiftProductGroup = {
  readonly productId: string;
  readonly options: readonly GiftOptionView[];
};

export type AndProductGroup = {
  readonly productId: string;
  readonly productLabel: string;
  readonly variants: readonly GiftItemView[];
};

// Group options by product, preserving first-seen order of both products and options. Every option
// is retained as a distinct entry — NO product-level dedup. A product contributing multiple variants
// yields one group with multiple options (5b renders a variant selector); single-variant products
// yield a one-option group (5b renders a single card).
export function groupGiftOptionsByProduct(
  options: readonly GiftOptionView[],
): readonly GiftProductGroup[] {
  const order: string[] = [];
  const byProduct = new Map<string, GiftOptionView[]>();
  for (const option of options) {
    const existing = byProduct.get(option.productId);
    if (existing === undefined) {
      order.push(option.productId);
      byProduct.set(option.productId, [option]);
    } else {
      existing.push(option);
    }
  }
  return order.map((productId) => ({ productId, options: byProduct.get(productId) ?? [] }));
}

// Group AND-tier gifts by product for the per-product variant picker. Same insertion-order
// semantics as groupGiftOptionsByProduct. Single-variant products yield a one-variant group
// (rendered as a locked card); multi-variant products yield a group with a variant selector.
export function groupAndGiftsByProduct(gifts: readonly GiftItemView[]): readonly AndProductGroup[] {
  const order: string[] = [];
  const byProduct = new Map<string, GiftItemView[]>();
  for (const gift of gifts) {
    const existing = byProduct.get(gift.productId);
    if (existing === undefined) {
      order.push(gift.productId);
      byProduct.set(gift.productId, [gift]);
    } else {
      existing.push(gift);
    }
  }
  return order.map((productId) => {
    const variants = byProduct.get(productId) ?? [];
    return { productId, productLabel: variants[0]?.productLabel ?? '', variants };
  });
}

// Initial per-tier selection so the gift is INCLUDED by default (the decline spec).
// - OR tiers: picks the first AVAILABLE option; falls back to first option (gift-unavailable backstop).
// - AND tiers: groups gifts by productId, picks the first AVAILABLE variant per product (same
//   availability criterion as OR). Stored as compound keys `tierId:productId → variantId`.
//   Falls back to first variant per product when none is available.
// Returns the choices map consumed by /validate: simple keys for OR, compound keys for AND.
export function defaultGiftChoices(tiers: readonly TierConfig[]): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const tier of tiers) {
    if (tier.gift.kind === 'OR') {
      const pick = tier.gift.options.find((o) => o.available) ?? tier.gift.options[0];
      if (pick !== undefined) {
        choices[tier.tierId] = pick.optionId;
      }
    } else {
      const byProduct = new Map<string, (typeof tier.gift.gifts)[number]>();
      for (const gift of tier.gift.gifts) {
        if (byProduct.has(gift.productId)) continue;
        byProduct.set(gift.productId, gift);
      }
      for (const gift of tier.gift.gifts) {
        const current = byProduct.get(gift.productId)!;
        if (!current.available && gift.available) {
          byProduct.set(gift.productId, gift);
        }
      }
      for (const [productId, gift] of byProduct) {
        choices[`${tier.tierId}:${productId}`] = gift.variantId;
      }
    }
  }
  return choices;
}
