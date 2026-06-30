// PURE gift-line classification for the cart drawer (Stage 0). No DOM, no I/O — unit-tested here;
// groupingTransform.ts hides gets + lingering so the chooser is the sole gift representation.
//
// Authoritative classification is ALLOCATION-primary, scoped to OUR code (not bare $0), because of
// accepted issue #6: under model-C the same gift product can be bought full-price AND received free,
// and Shopify may put the $0 on the UNMARKED split while `_fge_gift` lands on the full-price split.
//   GETS      = lines zeroed by OUR discount (final_line_price===0 AND allocation title === ourCode)
//   LINGERING = marked (_fge_gift==1) AND not zeroed AND no same-variant gets sibling -> "pending"
//   (everything else stays visible as the theme renders it — no buy-line merge)

export type RawCartLine = {
  readonly index: number;
  readonly key: string;
  readonly variantId: number;
  readonly quantity: number;
  readonly finalLinePrice: number;
  readonly originalLinePrice: number;
  readonly marked: boolean;
  readonly allocationTitles: readonly string[];
};

export type GiftLineRef = {
  readonly index: number;
  readonly key: string;
  readonly variantId: number;
};

export type GroupingPlan = {
  readonly gets: readonly GiftLineRef[];
  readonly lingering: readonly GiftLineRef[];
  readonly hasGifts: boolean;
  readonly lineCount: number;
};

function isZeroedByOurCode(line: RawCartLine, ourCode: string | null): boolean {
  return line.finalLinePrice === 0 && ourCode !== null && line.allocationTitles.includes(ourCode);
}

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

  for (const line of lines) {
    if (isZeroedByOurCode(line, ourCode)) {
      gets.push({ index: line.index, key: line.key, variantId: line.variantId });
    } else if (line.marked && !zeroedVariantIds.has(line.variantId)) {
      lingering.push({ index: line.index, key: line.key, variantId: line.variantId });
    }
  }

  return {
    gets,
    lingering,
    hasGifts: gets.length > 0 || lingering.length > 0,
    lineCount: lines.length,
  };
}
