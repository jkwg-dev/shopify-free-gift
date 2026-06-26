// Pure grouping helper for the OR chooser (Phase 5a defines it; 5b renders it). The GiftOptionView
// type now lives in core (the campaign-config contract home) and is re-exported here so the widget
// keeps a single import surface. Grouping is for PRESENTATION only and must preserve every variant
// as its own selectable option — the reconciler keys on variant GID and never dedups by product.
import type { GiftOptionView, TierConfig } from '@free-gift-engine/core';

export type { GiftOptionView };

export type GiftProductGroup = {
  readonly productId: string;
  readonly options: readonly GiftOptionView[];
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

// Initial per-tier OR selection so the gift is INCLUDED by default (the decline spec). Picks the
// first AVAILABLE option per OR tier; if none is available, falls back to the first option (the gift
// is then unfulfillable and /validate's gift-unavailable is the backstop). AND tiers have no choice.
// Returns the choices map in the EXISTING /validate `choices` shape (tierId -> optionId) — only the
// SOURCE moved from the default_choices seam to here.
export function defaultGiftChoices(tiers: readonly TierConfig[]): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const tier of tiers) {
    if (tier.gift.kind !== 'OR') {
      continue;
    }
    const pick = tier.gift.options.find((o) => o.available) ?? tier.gift.options[0];
    if (pick !== undefined) {
      choices[tier.tierId] = pick.optionId;
    }
  }
  return choices;
}
