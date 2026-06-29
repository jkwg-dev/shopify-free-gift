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

// One merged purchase row. The INTERACTIVE row reflects ONLY the controllable (unmarked) units —
// display + control are over the same set, so a +/-/delete can never no-op (issue-#6 decision §M).
// A `_fge_gift`-MARKED unit that lands in a buy group (rare model-C overlap) is excluded here and
// surfaced read-only (`readOnlyIndexes`); the buy control never writes a marked key (write-safety).
export type BuyRow = {
  readonly variantId: number;
  // Controllable (unmarked) units — what the interactive merged row shows and its controls drive.
  readonly controllableQuantity: number;
  readonly controllableFinalPrice: number;
  readonly controllableOriginalPrice: number;
  // Cart index of the line node made interactive (first unmarked line); null if the group is all-marked.
  readonly interactiveIndex: number | null;
  // Other unmarked line indexes — hidden in place (their qty/price are folded into the interactive row).
  readonly hideIndexes: readonly number[];
  // Marked line indexes in this variant group (issue-#6) — rendered read-only, never written.
  readonly readOnlyIndexes: readonly number[];
  // Unmarked line keys; [0] is the canonical write target, the rest are zeroed in one atomic update.
  readonly writableKeys: readonly string[];
  // >1 unmarked line (Shopify-split) → the merged control needs the atomic multi-key write.
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
  // Total cart lines the plan was built from — the DOM transform fails open if the rendered line
  // count differs (stale plan mid-re-render / a theme it can't correlate).
  readonly lineCount: number;
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
  return {
    gets,
    lingering,
    buys,
    hasGifts: gets.length > 0 || lingering.length > 0,
    lineCount: lines.length,
  };
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
    const unmarked = group.filter((l) => !l.marked); // controllable + writable
    const marked = group.filter((l) => l.marked); // issue-#6 overlap: read-only, never written
    return {
      variantId,
      controllableQuantity: unmarked.reduce((n, l) => n + l.quantity, 0),
      controllableFinalPrice: unmarked.reduce((n, l) => n + l.finalLinePrice, 0),
      controllableOriginalPrice: unmarked.reduce((n, l) => n + l.originalLinePrice, 0),
      interactiveIndex: unmarked[0]?.index ?? null,
      hideIndexes: unmarked.slice(1).map((l) => l.index),
      readOnlyIndexes: marked.map((l) => l.index),
      writableKeys: unmarked.map((l) => l.key),
      split: unmarked.length > 1,
    };
  });
}
