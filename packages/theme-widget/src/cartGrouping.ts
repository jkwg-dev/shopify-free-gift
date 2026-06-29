// PURE classification + buy-merge for the two-group cart-drawer view (Stage 0). No DOM, no I/O —
// unit-tested here; the DOM adapter (groupingTransform.ts) consumes this plan and correlates it to the
// theme's rendered line nodes by cart order. Design: docs/cart-two-group-grouping-design.md.
//
// Authoritative classification is ALLOCATION-primary, scoped to OUR code (not bare $0), because of
// accepted issue #6: under model-C the same gift product can be bought full-price AND received free,
// and Shopify may put the $0 on the UNMARKED split while `_fge_gift` lands on the full-price split.
//   GETS      = lines zeroed by OUR discount (final_line_price===0 AND an allocation title === ourCode)
//   LINGERING = marked (_fge_gift==1) AND not zeroed AND no same-variant gets sibling -> "pending"
//   BUYS      = everything else, merged by variant
// gets/lingering are extracted FIRST, so the buys-merge can never absorb the gift (incl. issue #6).

// One cart line as the widget reads it from /cart.js (minor-unit integer prices), enriched with the
// signals the grouping needs. `index` is the position in cart.items (for DOM correlation by order).
export type RawCartLine = {
  readonly index: number;
  readonly key: string;
  readonly variantId: number;
  readonly quantity: number;
  readonly finalLinePrice: number;
  readonly originalLinePrice: number;
  // `_fge_gift == "1"` line property present (the app's gift marker).
  readonly marked: boolean;
  // discount_application titles on this line's allocations (a code discount's title IS the code).
  readonly allocationTitles: readonly string[];
};

// A gift/lingering line keeps its own identity (rendered read-only / "pending"); buys are merged.
export type GiftLineRef = {
  readonly index: number;
  readonly key: string;
  readonly variantId: number;
};

// One merged purchase row: all same-variant non-gift lines collapsed. `displayIndexes[0]` is the node
// the adapter keeps + relabels; the rest are removed. `writableKeys` (Stage 2) excludes any marked
// line so a buy control never zeroes a reconcile-owned gift line (issue-#6 write-safety).
export type BuyRow = {
  readonly variantId: number;
  readonly totalQuantity: number;
  readonly totalFinalPrice: number;
  readonly totalOriginalPrice: number;
  readonly displayIndexes: readonly number[];
  readonly writableKeys: readonly string[];
  readonly split: boolean;
};

export type GroupingPlan = {
  // Realized free gift(s): zeroed by our code. Rendered read-only with a "Free gift" label.
  readonly gets: readonly GiftLineRef[];
  // Marked but not (yet) free and with no zeroed sibling — rendered "Free gift — pending", price shown.
  readonly lingering: readonly GiftLineRef[];
  // Purchase lines, merged by variant, in first-occurrence cart order.
  readonly buys: readonly BuyRow[];
  // Whether to show the two-group framing (+ the "Your purchase" header). False => buys-only, no header.
  readonly hasGifts: boolean;
};

function isZeroedByOurCode(line: RawCartLine, ourCode: string | null): boolean {
  return line.finalLinePrice === 0 && ourCode !== null && line.allocationTitles.includes(ourCode);
}

// Classify every line and merge the buys. Pure + order-preserving (DOM correlates by `index`).
export function classifyAndGroup(
  lines: readonly RawCartLine[],
  ourCode: string | null,
): GroupingPlan {
  const zeroedVariantIds = new Set<number>();
  for (const line of lines) {
    if (isZeroedByOurCode(line, ourCode)) {
      zeroedVariantIds.add(line.variantId);
    }
  }

  const gets: GiftLineRef[] = [];
  const lingering: GiftLineRef[] = [];
  const buyLines: RawCartLine[] = [];

  for (const line of lines) {
    if (isZeroedByOurCode(line, ourCode)) {
      gets.push({ index: line.index, key: line.key, variantId: line.variantId });
    } else if (line.marked && !zeroedVariantIds.has(line.variantId)) {
      // Marked, not zeroed, and no same-variant gets sibling => a gift that should be free but isn't.
      lingering.push({ index: line.index, key: line.key, variantId: line.variantId });
    } else {
      // Everything else is a purchase. (A marked line WITH a zeroed sibling — issue #6 — lands here as
      // a legitimate full-price unit; its key is excluded from writableKeys below.)
      buyLines.push(line);
    }
  }

  const buys = mergeBuysByVariant(buyLines);
  return { gets, lingering, buys, hasGifts: gets.length > 0 || lingering.length > 0 };
}

// Merge buy lines by variant, preserving first-occurrence order. Exported for direct testing.
export function mergeBuysByVariant(buyLines: readonly RawCartLine[]): BuyRow[] {
  const order: number[] = [];
  const byVariant = new Map<number, RawCartLine[]>();
  for (const line of buyLines) {
    const existing = byVariant.get(line.variantId);
    if (existing === undefined) {
      byVariant.set(line.variantId, [line]);
      order.push(line.variantId);
    } else {
      existing.push(line);
    }
  }

  return order.map((variantId) => {
    const group = byVariant.get(variantId) as RawCartLine[];
    return {
      variantId,
      totalQuantity: group.reduce((n, l) => n + l.quantity, 0),
      totalFinalPrice: group.reduce((n, l) => n + l.finalLinePrice, 0),
      totalOriginalPrice: group.reduce((n, l) => n + l.originalLinePrice, 0),
      displayIndexes: group.map((l) => l.index),
      // Stage-2 write safety: never write a reconcile-owned (marked) line via a buy control.
      writableKeys: group.filter((l) => !l.marked).map((l) => l.key),
      split: group.length > 1,
    };
  });
}
