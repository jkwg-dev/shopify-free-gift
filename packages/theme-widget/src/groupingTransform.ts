// Stage 1 DOM transform (theme-coupled, FAIL-OPEN). Consumes the pure GroupingPlan (cartGrouping.ts)
// and rewrites the theme's already-rendered cart-line list into two labeled groups — "Your purchase"
// (buys) then "Your free gift(s)" (gets) — display-merging same-variant buy lines and making the gets
// group read-only with a "Free gift" label. PRESENTATION ONLY: issues NO cart write; only reorders,
// inserts header rows, hides merged siblings, rewrites qty/price text, and relabels our discount.
//
// Structure-safe: it does NOT reparent line nodes (Dawn renders <tr class="cart-item"> inside a
// <table>, so moving them into <div> groups would break the table). Instead it reorders the lines
// within their existing parent and inserts group headers as siblings (a <tr><td colspan> for tables,
// a <div> otherwise). Correlation is by cart ORDER (lineNodes[i] <-> cart.items[i]); if the rendered
// line count does not match the plan it FAILS OPEN (leaves the theme's untouched list).
//
// Untested here (DOM adapter, like renderChooser) — verified on dev. Dawn selectors are best-effort
// with fallbacks; tune on dev if the production theme deviates (fail-open keeps it safe meanwhile).
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
const QTY_TEXT_SELECTORS = ['.quantity__input', 'input.quantity__input', '[name="updates[]"]'];
const QTY_CONTROL_SELECTORS = ['.cart-item__quantity', '.quantity', 'quantity-input'];
const REMOVE_SELECTORS = ['cart-remove-button', '.button--tertiary', '[id^="Remove-"]'];
const PRICE_SELECTORS = ['.cart-item__price-wrapper', '.cart-item__totals', '.cart-item__price'];
const DISCOUNT_SELECTORS = ['ul.discounts', '.cart-item__discounts', '.discounts'];

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

function formatMoney(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      minorUnits / 100,
    );
  } catch {
    // Unknown/zero-decimal currency or no Intl: degrade to a bare number rather than throw.
    return String(minorUnits / 100);
  }
}

// A group header as a sibling of the line nodes: a <tr><td colspan> when the lines are table rows,
// else a <div>. colspan is intentionally over-large (browsers clamp) so we needn't count columns.
function makeHeader(line: HTMLElement, text: string, sub: string | null): HTMLElement {
  const isRow = line.tagName === 'TR';
  const header = document.createElement(isRow ? 'tr' : 'div');
  header.className = 'fge fge-group-head';
  header.setAttribute('role', 'presentation');
  const inner = isRow ? document.createElement('td') : header;
  if (isRow) {
    inner.setAttribute('colspan', '100');
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

function setMergedQtyAndPrice(
  node: HTMLElement,
  qty: number,
  finalPrice: number,
  currency: string,
): void {
  const qtyInput = findFirst(node, QTY_TEXT_SELECTORS);
  if (qtyInput instanceof HTMLInputElement) {
    qtyInput.value = String(qty);
  } else if (qtyInput !== null) {
    qtyInput.textContent = String(qty);
  }
  const priceEl = findFirst(node, PRICE_SELECTORS);
  if (priceEl !== null) {
    // Overwrite the line total with the merged sum. We own this row's qty/price text (the only way the
    // displayed number is deterministic — a raw cart write does not make the theme re-render).
    priceEl.textContent = formatMoney(finalPrice, currency);
  }
}

function disableControls(node: HTMLElement): void {
  for (const sel of [...QTY_CONTROL_SELECTORS, ...REMOVE_SELECTORS]) {
    node.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    });
  }
}

// Rewrite the theme-rendered discount label to "Free gift" when it is OUR code (so a merchant's other
// promo is left untouched). Returns whether a label was found + relabeled.
function relabelOurDiscount(node: HTMLElement, ourCode: string | null): boolean {
  const discountEl = findFirst(node, DISCOUNT_SELECTORS);
  if (discountEl === null) return false;
  // If we can't confirm the code (none known), still replace inside a gift line — the gift's only
  // discount is ours by construction.
  if (ourCode === null || discountEl.textContent?.includes(ourCode) === true) {
    discountEl.textContent = FREE_GIFT_LABEL;
    discountEl.classList.add('fge-free-badge');
    return true;
  }
  return false;
}

// Add a small badge into a gift line (idempotent). Used as the "Free gift" indicator when the theme
// rendered no discount label, and for the lingering "Free gift — pending" state.
function injectBadge(node: HTMLElement, text: string): void {
  if (node.querySelector('.fge-line-badge') !== null) return;
  const host = findFirst(node, PRICE_SELECTORS) ?? node;
  const badge = document.createElement('span');
  badge.className = 'fge fge-line-badge';
  badge.textContent = text;
  host.prepend(badge);
}

export type GroupingTransformOptions = {
  readonly currency: string;
  readonly ourCode: string | null;
  // Stage 1 only: disable the buy stepper on Shopify-split rows (the merged-control write is Stage 2).
  readonly disableSplitBuyStepper: boolean;
};

// Apply the two-group layout to one theme items container. Returns true if it grouped, false if it
// failed open (left the theme list untouched). Idempotent: re-running on an already-grouped container
// (same render) is a no-op; the theme's next re-render wipes our markers and we re-group from scratch.
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
  // FAIL OPEN: no lines, nothing to group, or the rendered list doesn't match the plan we built from
  // /cart.js (stale plan mid-re-render, or a theme we can't correlate) -> leave the theme list intact.
  if (total === 0 || lineNodes.length !== total) return false;

  // Idempotency: if we've already grouped THIS render (our header is present), do nothing.
  if (itemsEl.querySelector('.fge-group-head') !== null) return true;

  const parent = lineNodes[0]?.parentElement ?? null;
  if (parent === null) return false;

  itemsEl.setAttribute(MARK, '');

  // BUYS group: one row per variant (first split kept; others hidden in place). Header only when there
  // is also a gift (no orphan "Your purchase" header in the no-gift state).
  if (plan.buys.length > 0 && plan.hasGifts) {
    const firstBuy = lineNodes[plan.buys[0]!.displayIndexes[0]!];
    if (firstBuy != null) parent.insertBefore(makeHeader(firstBuy, BUYS_HEADER, null), firstBuy);
  }
  for (const row of plan.buys) {
    const [keepIdx, ...hideIdxs] = row.displayIndexes;
    const keep = keepIdx === undefined ? null : lineNodes[keepIdx];
    if (keep == null) continue;
    setMergedQtyAndPrice(keep, row.totalQuantity, row.totalFinalPrice, opts.currency);
    if (row.split && opts.disableSplitBuyStepper) disableControls(keep);
    parent.append(keep); // reorder: buys first, in first-occurrence order
    for (const hideIdx of hideIdxs) {
      const sib = lineNodes[hideIdx];
      if (sib != null) {
        sib.style.display = 'none';
        sib.setAttribute(HIDDEN_MARK, '');
        parent.append(sib); // keep adjacent to its merged row, out of view
      }
    }
  }

  // GETS group: realized gifts then lingering, all read-only, header reflects count.
  if (plan.hasGifts) {
    const giftCount = plan.gets.length + plan.lingering.length;
    const firstGiftIdx = plan.gets[0]?.index ?? plan.lingering[0]?.index;
    const firstGift = firstGiftIdx === undefined ? null : lineNodes[firstGiftIdx];
    if (firstGift != null) {
      const header = makeHeader(
        firstGift,
        giftCount > 1 ? GETS_HEADER_MANY : GETS_HEADER_ONE,
        GETS_SUBLABEL,
      );
      parent.append(header);
    }
    for (const ref of plan.gets) {
      const node = lineNodes[ref.index];
      if (node == null) continue;
      disableControls(node);
      if (!relabelOurDiscount(node, opts.ourCode)) injectBadge(node, FREE_GIFT_LABEL);
      node.classList.add('fge-gift-line');
      parent.append(node);
    }
    for (const ref of plan.lingering) {
      const node = lineNodes[ref.index];
      if (node == null) continue;
      disableControls(node); // app-managed; reconcile converges it
      node.classList.add('fge-gift-line', 'fge-gift-line--pending');
      injectBadge(node, LINGERING_LABEL); // price stays shown; never a silent FREE
      parent.append(node);
    }
  }

  return true;
}
