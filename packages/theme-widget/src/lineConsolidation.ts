// PURE consolidation of duplicate cart lines (no DOM, no I/O — unit-tested here).
//
// Shopify's BXGY gift code allocates its "customer buys" prerequisite to only ENOUGH units to meet
// the threshold, and it will NOT merge a newly-added unit into a line that already carries that
// allocation — so the SAME product (same variant + same properties) can appear as TWO cart lines:
// one with the $0 "entitled" allocation and one without. To a shopper that reads as a duplicate /
// bug ("why is this product listed twice?"). Shopify won't collapse them via discount config, so the
// widget normalizes the cart itself: merge same-(variant, properties) NON-GIFT lines into one.
//
// Gift lines (the app-added `_fge_gift` unit) are NEVER merged here — a full-price unit and a $0 gift
// unit of the same variant are intentionally separate (the paid-duplicate rule), and they carry
// different properties anyway, so they never fall in the same group.

export type ConsolidationLine = {
  // Theme line key (cart/update.js `updates` target).
  readonly key: string;
  readonly variantId: number;
  readonly quantity: number;
  // Stable serialization of the line's properties (empty string = no properties). Lines only merge
  // when this matches exactly, so an engraving / OR-choice property never merges into a plain line.
  readonly propertiesKey: string;
  readonly isGift: boolean;
};

// Build the cart/update.js `updates` map that merges every group of >1 non-gift lines sharing
// (variantId, propertiesKey): the FIRST line's key takes the group's TOTAL quantity, the rest go to 0
// (removed). Returns null when there is nothing to merge (the common, already-consolidated case), so
// the caller can skip the write entirely.
export function planLineConsolidation(
  lines: readonly ConsolidationLine[],
): Record<string, number> | null {
  const groups = new Map<string, ConsolidationLine[]>();
  for (const line of lines) {
    if (line.isGift) continue;
    const groupKey = `${line.variantId}\u0000${line.propertiesKey}`;
    const existing = groups.get(groupKey);
    if (existing) existing.push(line);
    else groups.set(groupKey, [line]);
  }

  const updates: Record<string, number> = {};
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const total = group.reduce((sum, l) => sum + l.quantity, 0);
    updates[group[0]!.key] = total;
    for (let i = 1; i < group.length; i += 1) {
      updates[group[i]!.key] = 0;
    }
  }

  return Object.keys(updates).length > 0 ? updates : null;
}
