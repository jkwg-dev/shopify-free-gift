// Gift-line DOM adapter (theme-coupled, FAIL-OPEN). Hides gets + lingering cart lines so the
// chooser is the sole gift representation. Buy lines are untouched — Dawn renders them as-is.
//
// Correlation is by cart ORDER (lineNodes[i] <-> cart.items[i]).
import type { GroupingPlan } from './cartGrouping.js';
import type { MergePlan } from './lineMerge.js';

const LINE_SELECTORS = [
  '.cart-item',
  '[id^="CartDrawer-Item-"]',
  '[id^="CartItem-"]',
  'cart-item',
  '.cart__row',
];
const QTY_INPUT_SELECTORS = [
  '.quantity__input',
  'input[name="updates[]"]',
  'input[name*="quantity" i]',
  'input[type="number"]',
];
// Theme-specific line-TOTAL price containers (line-item.liquid `line_price_display`): the cart drawer
// puts it in `.cart-item__actions--price`, the full /cart page in `.cart-item__total-price`. The unit
// price (`.cart-item__price` inside `.cart-item__content`) is per-unit and unchanged by a merge, so we
// only repaint the line total.
const LINE_TOTAL_SELECTORS = ['.cart-item__actions--price', '.cart-item__total-price'];
const DEC_BTN_SELECTOR = '.quantity__button[name="decrement"], .quantity__button[name="minus"]';
const INC_BTN_SELECTOR = '.quantity__button[name="increment"], .quantity__button[name="plus"]';

const MARK = 'data-fge-grouped';
const HIDDEN_MARK = 'data-fge-gift-hidden';
// Merged-line marks: the visible "primary" row that shows the group total + carries the group keys,
// and the hidden sibling rows whose quantity rolls into it. Read by the storefront's group-aware
// stepper/remove interceptors and by the qty-sync helpers below (which skip both).
export const MERGE_PRIMARY_ATTR = 'data-fge-merge-primary';
export const MERGE_KEYS_ATTR = 'data-fge-merge-keys';
const MERGE_HIDDEN_MARK = 'data-fge-merge-hidden';

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

function resetGiftHides(lineNodes: HTMLElement[]): void {
  for (const node of lineNodes) {
    if (node.hasAttribute(HIDDEN_MARK)) {
      node.style.display = '';
      node.removeAttribute(HIDDEN_MARK);
    }
  }
}

// Hide gift lines (gets + lingering). Buy lines stay visible with native Dawn controls.
// FAIL-OPEN on a node/plan count mismatch (either direction): return false so the caller keeps the
// FOUC mask up, and let the AUTHORITATIVE verified-reconcile path (refreshItemsBody, which diffs the
// DOM against cart.js) align the DOM. We do NOT blindly remove "surplus" nodes here: when the drawer
// re-renders the full cart but `lastPlan` is still stale (smaller lineCount), removing the trailing
// nodes deletes real buy rows and the cart flashes showing only the first row (bug 2).
export function applyGiftLineHiding(itemsEl: HTMLElement | null, plan: GroupingPlan): boolean {
  if (itemsEl === null) return false;
  if (plan.lineCount === 0) return false;

  const lineNodes = findLineNodes(itemsEl);

  if (lineNodes.length !== plan.lineCount) return false;

  resetGiftHides(lineNodes);

  (itemsEl.closest('cart-drawer-items, cart-items') ?? itemsEl).setAttribute(MARK, '');

  for (const ref of [...plan.gets, ...plan.lingering]) {
    const node = lineNodes[ref.index];
    if (node != null) {
      node.style.display = 'none';
      node.setAttribute(HIDDEN_MARK, '');
    }
  }

  return true;
}

// Set a merged primary row's quantity input to the GROUP total (not its own sub-line qty) and refresh
// the theme's +/- disabled states to match — WITHOUT dispatching a change (the storefront intercepts
// the primary's change to write the whole group; a synthetic dispatch here would loop).
function setPrimaryQuantity(node: HTMLElement, total: number): void {
  const input = findFirst(node, QTY_INPUT_SELECTORS);
  if (!(input instanceof HTMLInputElement)) return;
  const value = String(total);
  if (input.value !== value) {
    input.value = value;
    input.setAttribute('value', value);
  }
  const min = input.min !== '' ? Number.parseInt(input.min, 10) : null;
  const max = input.max !== '' ? Number.parseInt(input.max, 10) : null;
  const dec = node.querySelector<HTMLButtonElement>(DEC_BTN_SELECTOR);
  const inc = node.querySelector<HTMLButtonElement>(INC_BTN_SELECTOR);
  if (dec !== null && min !== null) {
    const atMin = total <= min;
    dec.classList.toggle('disabled', atMin);
    dec.disabled = atMin;
  }
  if (inc !== null && max !== null) {
    const atMax = total >= max;
    inc.classList.toggle('disabled', atMax);
    inc.disabled = atMax;
  }
}

// Repaint a merged primary row's LINE TOTAL to the group total. Merge only ever targets full-price
// lines, so the theme rendered a plain `<span class="cart-item__price">$X</span>` (no ins/del) — we
// set that span's text. Leaves the per-unit price untouched (it does not change with quantity).
function setLineTotalPrice(node: HTMLElement, formatted: string): void {
  for (const sel of LINE_TOTAL_SELECTORS) {
    const container = node.querySelector<HTMLElement>(sel);
    if (container === null) continue;
    const priceEl = container.querySelector<HTMLElement>('.cart-item__price') ?? container;
    priceEl.textContent = formatted;
  }
}

function resetMergeMarks(lineNodes: HTMLElement[]): void {
  for (const node of lineNodes) {
    if (node.hasAttribute(MERGE_HIDDEN_MARK)) {
      node.style.display = '';
      node.removeAttribute(MERGE_HIDDEN_MARK);
    }
    node.removeAttribute(MERGE_PRIMARY_ATTR);
    node.removeAttribute(MERGE_KEYS_ATTR);
  }
}

// Collapse each merged group into its primary DOM row: hide the sibling nodes, roll their quantity +
// line total into the primary, and stamp the group keys so the storefront's interceptors can write
// the whole group. Idempotent (resets prior merge marks first) and re-run after every theme
// re-render. FAIL-OPEN on a node/line count mismatch: return false so the caller keeps the FOUC mask
// up and lets the authoritative refresh realign the DOM (same contract as applyGiftLineHiding).
//
// Correlation is by cart ORDER (lineNodes[i] <-> the i-th cart line), matching applyGiftLineHiding.
// `formatTotal` renders minor units with the theme's money format so the merged total is visually
// identical to a theme-rendered price.
export function applyLineMerge(
  itemsEl: HTMLElement | null,
  plan: MergePlan,
  totalLines: number,
  formatTotal: (minorUnits: number) => string,
): boolean {
  if (itemsEl === null) return false;
  const lineNodes = findLineNodes(itemsEl);
  if (lineNodes.length !== totalLines) return false;

  resetMergeMarks(lineNodes);

  for (const group of plan.groups) {
    const primary = lineNodes[group.primaryIndex];
    if (primary == null) continue;
    primary.setAttribute(MERGE_PRIMARY_ATTR, '');
    primary.setAttribute(MERGE_KEYS_ATTR, JSON.stringify(group.keys));
    setPrimaryQuantity(primary, group.totalQuantity);
    setLineTotalPrice(primary, formatTotal(group.totalFinalPrice));
    for (const idx of group.hiddenIndices) {
      const node = lineNodes[idx];
      if (node != null) {
        node.style.display = 'none';
        node.setAttribute(MERGE_HIDDEN_MARK, '');
      }
    }
  }

  return true;
}

// True when any visible (non-hidden) line's native qty input exceeds cart.js — Dawn is optimistically
// ahead of a stale snapshot (common during gift pending while the shopper taps +/- on a buy row).
export function shouldSkipNativeQtySync(
  itemsEl: HTMLElement | null,
  actualQuantities: readonly number[],
): boolean {
  if (itemsEl === null) return false;
  const lineNodes = findLineNodes(itemsEl);
  if (lineNodes.length !== actualQuantities.length) return false;
  for (let i = 0; i < lineNodes.length; i++) {
    const node = lineNodes[i]!;
    // Skip gift-hidden, merge-hidden, and merge-primary rows: a merged primary's input holds the
    // GROUP total (not its own sub-line qty), so it is legitimately > cart.js for that line and must
    // not be read as Dawn optimistically racing ahead.
    if (isFgeManagedRow(node)) continue;
    const input = findFirst(node, QTY_INPUT_SELECTORS);
    if (!(input instanceof HTMLInputElement)) continue;
    const domQty = Number.parseInt(input.value, 10);
    if (Number.isNaN(domQty)) continue;
    if (domQty > actualQuantities[i]!) return true;
  }
  return false;
}

// A row whose quantity input the FGE transform owns (gift-hidden, or part of a display merge): the
// authoritative per-line qty-sync must not overwrite it.
function isFgeManagedRow(node: HTMLElement): boolean {
  return (
    node.hasAttribute(HIDDEN_MARK) ||
    node.hasAttribute(MERGE_HIDDEN_MARK) ||
    node.hasAttribute(MERGE_PRIMARY_ATTR)
  );
}

// Sync native theme quantity inputs to authoritative cart values after reconcile. Skips FGE-managed
// rows (gift-hidden, merge-hidden, merge-primary): a gift row's qty (always 1) must not overwrite a
// visible buy row, and a merge-primary's input holds the group total, not its own per-line qty.
export function syncNativeInputs(
  itemsEl: HTMLElement | null,
  actualQuantities: readonly number[],
): void {
  if (itemsEl === null) return;
  const lineNodes = findLineNodes(itemsEl);
  if (lineNodes.length !== actualQuantities.length) return;
  for (let i = 0; i < lineNodes.length; i++) {
    const node = lineNodes[i]!;
    if (isFgeManagedRow(node)) continue;
    const input = findFirst(node, QTY_INPUT_SELECTORS);
    if (input instanceof HTMLInputElement) {
      const actual = String(actualQuantities[i]);
      if (input.value !== actual) {
        input.value = actual;
        input.setAttribute('value', actual);
      }
    }
  }
}
