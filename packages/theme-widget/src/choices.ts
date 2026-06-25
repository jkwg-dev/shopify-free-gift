// Variant-level gift-choice model for the OR chooser (Phase 5a defines it; 5b renders it). Each OR
// option is a distinct VARIANT carrying its product id + label + availability, so 5b can group
// sibling variants under one product and render a selector, and disable an out-of-stock variant
// (e.g. Collection Liquid L). Pure data + a pure grouping helper — no DOM. The reconciler keys on
// variant GID and never dedups by product, consistent with the backend; grouping here is for
// PRESENTATION only and must preserve every variant as its own selectable option.

export type GiftOptionView = {
  // The OR option id used as the /validate `choices` value (e.g. 'a', 'opt-3').
  readonly optionId: string;
  readonly variantId: string;
  // Product id for grouping in the UI; sibling variants share it. Never used to merge options.
  readonly productId: string;
  // Variant label shown in the selector (e.g. 'Ice', 'L').
  readonly variantLabel: string;
  // Out-of-stock options are rendered disabled (the /validate gift-unavailable status is the backstop).
  readonly available: boolean;
};

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
