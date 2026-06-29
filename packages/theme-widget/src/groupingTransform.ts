// Stage 1 DOM transform (theme-coupled, FAIL-OPEN). Consumes the pure GroupingPlan (cartGrouping.ts)
// and rewrites the theme's already-rendered cart-line list into two labeled groups — "Your purchase"
// (buys) then "Your free gift(s)" (gets) — display-merging same-variant buy lines and making the gets
// group read-only with a "Free gift" label. PRESENTATION ONLY: issues NO cart write; only reorders,
// inserts header rows, hides merged siblings, rewrites qty/line-total text, and relabels our discount.
//
// Structure-safe: it does NOT reparent line nodes (Dawn renders <tr class="cart-item"> inside a
// <table>, so moving them into <div> groups would break the table). It reorders the lines within their
// existing parent and inserts group headers as siblings (a <tr><td colspan> for tables, a <div> else).
// Correlation is by cart ORDER (lineNodes[i] <-> cart.items[i]); if the rendered line count doesn't
// match the plan, OR a split buy row has no line-total cell to overwrite, it FAILS OPEN (leaves the
// theme's untouched list) — never a stale number that contradicts the subtotal.
//
// Dawn renders the line total in MULTIPLE responsive cells (.cart-item__totals — one shown at narrow
// widths, another at wide), and the price text lives in different nodes per cell (a .price--end span,
// or directly in .cart-item__price-wrapper). We overwrite EVERY .cart-item__totals, preserving each
// node's native money format (CA$ vs $, grouping/decimal style) by replacing only the number in place.
//
// Untested here (DOM adapter, like renderChooser) — verified on dev. Selectors are Dawn best-effort.
import type { GroupingPlan } from './cartGrouping.js';

// --- copy (confirmed product decisions) ----------------------------------------------------------
const BUYS_HEADER = 'Your purchase';
const GETS_HEADER_ONE = 'Your free gift';
const GETS_HEADER_MANY = 'Your free gifts';
const GETS_SUBLABEL = 'Added free';
const LINGERING_LABEL = 'Free gift — pending';
const FREE_GIFT_LABEL = 'Free gift';

// --- Dawn selectors (multi, fallback; tune on dev) -----------------------------------------------
const LINE_SELECTORS = [
  '.cart-item',
  '[id^="CartDrawer-Item-"]',
  '[id^="CartItem-"]',
  'cart-item',
  '.cart__row',
];
const TOTALS_SELECTOR = '.cart-item__totals'; // the line-TOTAL cell (Dawn renders 2 responsive copies)
const FINAL_PRICE_SELECTORS = ['.price--end', '.cart-item__final-price'];
const OLD_PRICE_SELECTORS = ['.cart-item__old-price'];
const PRICE_WRAPPER = '.cart-item__price-wrapper';
const QTY_CELL_SELECTORS = ['.cart-item__quantity'];
const QTY_INPUT_SELECTORS = ['.quantity__input', 'input[name="updates[]"]'];
const QTY_BUTTON_SELECTORS = ['.quantity__button', 'cart-remove-button', '.button--tertiary'];
const REMOVE_SELECTORS = ['cart-remove-button', '.button--tertiary', '[id^="Remove-"]'];
const DISCOUNT_SELECTORS = ['ul.discounts', '.cart-item__discounts', '.discounts'];
const BADGE_HOST_SELECTORS = [TOTALS_SELECTOR, PRICE_WRAPPER, '.cart-item__price'];

const MARK = 'data-fge-grouped';
const HIDDEN_MARK = 'data-fge-merged-hidden';

function findFirst(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el !== null) return el;
  }
  return null;
}

function findLineNodes(itemsEl: HTMLElement): HTMLElement[] {
  for (const sel of LINE_SELECTORS) {
    const found = Array.from(itemsEl.querySelectorAll<HTMLElement>(sel));
    if (found.length > 0) return found;
  }
  return [];
}

// Replace ONLY the numeric value inside a node's existing price text with `sumMinorUnits`, preserving
// the node's currency prefix/suffix (CA$, $, €) and its grouping/decimal style. Returns null if the
// node has no number (caller leaves it untouched). This avoids a "CA$" vs "$" mismatch across Dawn's
// two responsive totals cells, which format differently.
function reformatPriceText(currentText: string, sumMinorUnits: number): string | null {
  const m = currentText.match(/\d[\d.,\u00A0\u202F' ]*\d|\d/);
  if (m === null) return null;
  const token = m[0];
  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');
  const decPos = Math.max(lastDot, lastComma);
  let decimals = 0;
  let decimalSep = '.';
  if (decPos !== -1 && /^\d{1,3}$/.test(token.slice(decPos + 1))) {
    decimals = token.length - decPos - 1;
    decimalSep = token.charAt(decPos);
  }
  // Grouping separator = the first separator char actually used in the integer part (space/nbsp/.,').
  const intText = decimals > 0 ? token.slice(0, decPos) : token;
  const gMatch = intText.match(/[.,\u00A0\u202F' ]/);
  const groupSep = gMatch !== null ? gMatch[0] : decimalSep === '.' ? ',' : '.';

  const fixed = (sumMinorUnits / Math.pow(10, decimals)).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? '' : fixed.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const num = decimals > 0 ? `${grouped}${decimalSep}${fracPart}` : grouped;
  return currentText.replace(token, num);
}

function reformatInPlace(el: HTMLElement | null, sumMinorUnits: number): void {
  if (el === null) return;
  const next = reformatPriceText(el.textContent ?? '', sumMinorUnits);
  if (next !== null) el.textContent = next;
}

// Overwrite the line total in EVERY responsive .cart-item__totals cell (and the strikethrough, if any)
// with the merged sums. Leaves the per-UNIT price alone (it lives in .cart-item__details, not totals).
function setLineTotals(node: HTMLElement, sumFinal: number, sumOriginal: number): void {
  node.querySelectorAll<HTMLElement>(TOTALS_SELECTOR).forEach((cell) => {
    const wrapper = cell.querySelector<HTMLElement>(PRICE_WRAPPER) ?? cell;
    const finalEl =
      findFirst(wrapper, FINAL_PRICE_SELECTORS) ??
      wrapper.querySelector<HTMLElement>('.price:not(.cart-item__old-price)') ??
      wrapper;
    reformatInPlace(finalEl, sumFinal);
    reformatInPlace(findFirst(wrapper, OLD_PRICE_SELECTORS), sumOriginal);
  });
}

// Show the merged quantity as READ-ONLY text (the number stays visible), disabling the +/- and remove
// controls. Stage 2 makes this same number interactive. Does NOT hide the quantity cell.
function showMergedQtyReadOnly(node: HTMLElement, qty: number): void {
  const input = findFirst(node, QTY_INPUT_SELECTORS);
  if (input instanceof HTMLInputElement) {
    input.value = String(qty);
    input.setAttribute('value', String(qty));
    input.readOnly = true;
    input.style.pointerEvents = 'none';
  }
  for (const sel of QTY_BUTTON_SELECTORS) {
    node.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    });
  }
}

// Fully hide qty + remove controls (for the read-only GIFT group — no quantity shown for a free gift).
function hideControls(node: HTMLElement): void {
  for (const sel of [...QTY_CELL_SELECTORS, ...REMOVE_SELECTORS]) {
    node.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    });
  }
}

// Rewrite the theme-rendered discount label to "Free gift" when it is OUR code (a merchant's other
// promo is left untouched). Returns whether a label was found + relabeled.
function relabelOurDiscount(node: HTMLElement, ourCode: string | null): boolean {
  const discountEl = findFirst(node, DISCOUNT_SELECTORS);
  if (discountEl === null) return false;
  if (ourCode === null || discountEl.textContent?.includes(ourCode) === true) {
    discountEl.textContent = FREE_GIFT_LABEL;
    discountEl.classList.add('fge-free-badge');
    return true;
  }
  return false;
}

// Add a badge into a gift line (idempotent): the "Free gift" indicator when the theme shows no discount
// label, and the lingering "Free gift — pending" state.
function injectBadge(node: HTMLElement, text: string): void {
  if (node.querySelector('.fge-line-badge') !== null) return;
  const host = findFirst(node, BADGE_HOST_SELECTORS) ?? node;
  const badge = document.createElement('span');
  badge.className = 'fge fge-line-badge';
  badge.textContent = text;
  host.prepend(badge);
}

function makeHeader(line: HTMLElement, text: string, sub: string | null): HTMLElement {
  const isRow = line.tagName === 'TR';
  const header = document.createElement(isRow ? 'tr' : 'div');
  header.className = 'fge fge-group-head';
  header.setAttribute('role', 'presentation');
  const inner = isRow ? document.createElement('td') : header;
  if (isRow) {
    inner.setAttribute('colspan', '100'); // over-large; browsers clamp (no need to count columns)
    (inner as HTMLTableCellElement).className = 'fge-group-head__cell';
    header.append(inner);
  }
  const title = document.createElement('span');
  title.className = 'fge-group-head__title';
  title.textContent = text;
  inner.append(title);
  if (sub !== null) {
    const subEl = document.createElement('span');
    subEl.className = 'fge-group-head__sub';
    subEl.textContent = sub;
    inner.append(subEl);
  }
  return header;
}

export type GroupingTransformOptions = {
  readonly ourCode: string | null;
  // Stage 1 only: show the split-buy quantity read-only (the merged +/- write is Stage 2).
  readonly disableSplitBuyStepper: boolean;
};

// Apply the two-group layout to one theme items container. Returns true if it grouped, false if it
// failed open. Idempotent: re-running on an already-grouped render is a no-op; the theme's next
// re-render wipes our markers and we re-group from scratch.
export function applyTwoGroupLayout(
  itemsEl: HTMLElement | null,
  plan: GroupingPlan,
  opts: GroupingTransformOptions,
): boolean {
  if (itemsEl === null) return false;

  const lineNodes = findLineNodes(itemsEl);
  const total =
    plan.gets.length +
    plan.lingering.length +
    plan.buys.reduce((n, b) => n + b.displayIndexes.length, 0);
  // FAIL OPEN: nothing to group, or the rendered list doesn't match the plan we built from /cart.js.
  if (total === 0 || lineNodes.length !== total) return false;

  // Idempotency: already grouped THIS render (our header present) -> no-op.
  if (itemsEl.querySelector('.fge-group-head') !== null) return true;

  // FAIL OPEN (before mutating): a split buy row whose canonical node has NO line-total cell would
  // leave a stale total contradicting the subtotal — bail to the untouched theme list instead.
  for (const row of plan.buys) {
    if (!row.split) continue;
    const keep = lineNodes[row.displayIndexes[0] ?? -1];
    if (keep == null || keep.querySelector(TOTALS_SELECTOR) === null) return false;
  }

  const parent = lineNodes[0]?.parentElement ?? null;
  if (parent === null) return false;

  itemsEl.setAttribute(MARK, '');

  if (plan.buys.length > 0 && plan.hasGifts) {
    const firstBuy = lineNodes[plan.buys[0]!.displayIndexes[0]!];
    if (firstBuy != null) parent.insertBefore(makeHeader(firstBuy, BUYS_HEADER, null), firstBuy);
  }
  for (const row of plan.buys) {
    const [keepIdx, ...hideIdxs] = row.displayIndexes;
    const keep = keepIdx === undefined ? null : lineNodes[keepIdx];
    if (keep == null) continue;
    if (row.split) {
      // Only split rows need correction: overwrite the line total (every responsive cell) with the sum
      // and show the merged qty read-only. Non-split rows keep the theme's native (correct) numbers +
      // interactive stepper.
      setLineTotals(keep, row.totalFinalPrice, row.totalOriginalPrice);
      if (opts.disableSplitBuyStepper) showMergedQtyReadOnly(keep, row.totalQuantity);
    }
    parent.append(keep); // reorder: buys first, in first-occurrence order
    for (const hideIdx of hideIdxs) {
      const sib = lineNodes[hideIdx];
      if (sib != null) {
        sib.style.display = 'none';
        sib.setAttribute(HIDDEN_MARK, '');
        parent.append(sib);
      }
    }
  }

  if (plan.hasGifts) {
    const giftCount = plan.gets.length + plan.lingering.length;
    const firstGiftIdx = plan.gets[0]?.index ?? plan.lingering[0]?.index;
    const firstGift = firstGiftIdx === undefined ? null : lineNodes[firstGiftIdx];
    if (firstGift != null) {
      parent.append(
        makeHeader(firstGift, giftCount > 1 ? GETS_HEADER_MANY : GETS_HEADER_ONE, GETS_SUBLABEL),
      );
    }
    for (const ref of plan.gets) {
      const node = lineNodes[ref.index];
      if (node == null) continue;
      hideControls(node);
      if (!relabelOurDiscount(node, opts.ourCode)) injectBadge(node, FREE_GIFT_LABEL);
      node.classList.add('fge-gift-line');
      parent.append(node);
    }
    for (const ref of plan.lingering) {
      const node = lineNodes[ref.index];
      if (node == null) continue;
      hideControls(node); // app-managed; reconcile converges it
      node.classList.add('fge-gift-line', 'fge-gift-line--pending');
      injectBadge(node, LINGERING_LABEL); // price stays shown; never a silent FREE
      parent.append(node);
    }
  }

  return true;
}
