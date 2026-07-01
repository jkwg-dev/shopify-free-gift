// PURE planner for DISPLAY-merging duplicate cart lines (no DOM, no I/O — unit-tested here).
//
// Shopify's BXGY gift code allocates its "customer buys" prerequisite to only ENOUGH units to meet
// the threshold, and it will NOT merge a newly-added unit into the line that already carries that $0
// "entitled" allocation — so the SAME product (same variant + same properties) can appear as TWO
// cart lines (both at full price: one with a $0 marker, one without). A shopper reads that as a
// duplicate/bug ("why is this product listed twice?").
//
// A CART-API merge does NOT stick: Shopify re-splits the line to represent the partial allocation on
// the next recompute (verified live). So we merge at the DISPLAY layer instead — hide the extra
// node(s) and show the group total on the primary — and translate the primary row's stepper/remove
// back onto the whole group (see groupingTransform.applyLineMerge + the storefront interceptors).
//
// SAFETY (why this never touches other BOGO campaigns, e.g. Kite): a line only merges when its price
// is NOT actually reduced (`finalLinePrice === originalLinePrice`). Any real discount — a Kite BOGO
// $0 get-line, a percent-off, our own free gift — has `finalLinePrice < originalLinePrice`, so it is
// left as its own line. Gift lines (`isGift`) are also excluded outright.

export type MergeLine = {
  readonly index: number; // position in the cart (DOM correlation is by this order)
  readonly key: string; // theme line key (cart/update.js `updates` target)
  readonly variantId: number;
  // Stable serialization of the line's properties (empty string = no properties). Lines only merge
  // when this matches exactly, so an engraving / OR-choice property never merges into a plain line.
  readonly propertiesKey: string;
  readonly quantity: number;
  readonly isGift: boolean;
  readonly finalLinePrice: number; // minor units, AFTER discounts (per the whole line)
  readonly originalLinePrice: number; // minor units, BEFORE discounts (per the whole line)
};

export type MergeGroup = {
  readonly primaryIndex: number; // the kept, visible row
  readonly hiddenIndices: readonly number[]; // rows to hide (their qty rolls into the primary)
  readonly totalQuantity: number;
  readonly totalFinalPrice: number; // minor units — the merged row's line total
  readonly keys: readonly string[]; // all line keys in order (primary first) for group-wide writes
};

export type MergePlan = { readonly groups: readonly MergeGroup[] };

// A line is mergeable only when it is a non-gift line whose price is NOT reduced by any discount.
function isMergeable(line: MergeLine): boolean {
  return !line.isGift && line.finalLinePrice === line.originalLinePrice;
}

// Group mergeable lines by (variantId, propertiesKey). Any group with >1 line becomes a MergeGroup
// (primary = lowest index). Groups are returned ordered by primaryIndex for stable application.
export function planLineMerge(lines: readonly MergeLine[]): MergePlan {
  const buckets = new Map<string, MergeLine[]>();
  for (const line of lines) {
    if (!isMergeable(line)) continue;
    const bucketKey = `${line.variantId}\u0000${line.propertiesKey}`;
    const existing = buckets.get(bucketKey);
    if (existing) existing.push(line);
    else buckets.set(bucketKey, [line]);
  }

  const groups: MergeGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length <= 1) continue;
    const sorted = [...bucket].sort((a, b) => a.index - b.index);
    const primary = sorted[0]!;
    groups.push({
      primaryIndex: primary.index,
      hiddenIndices: sorted.slice(1).map((l) => l.index),
      totalQuantity: sorted.reduce((n, l) => n + l.quantity, 0),
      totalFinalPrice: sorted.reduce((n, l) => n + l.finalLinePrice, 0),
      keys: sorted.map((l) => l.key),
    });
  }

  groups.sort((a, b) => a.primaryIndex - b.primaryIndex);
  return { groups };
}
