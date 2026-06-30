// Gift-line DOM adapter (theme-coupled, FAIL-OPEN). Hides gets + lingering cart lines so the
// chooser is the sole gift representation. Buy lines are untouched — Dawn renders them as-is.
//
// Correlation is by cart ORDER (lineNodes[i] <-> cart.items[i]).
import type { GroupingPlan } from './cartGrouping.js';

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

const MARK = 'data-fge-grouped';
const HIDDEN_MARK = 'data-fge-gift-hidden';

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
export function applyGiftLineHiding(itemsEl: HTMLElement | null, plan: GroupingPlan): boolean {
  if (itemsEl === null) return false;
  if (plan.lineCount === 0) return false;

  const lineNodes = findLineNodes(itemsEl);

  if (lineNodes.length > plan.lineCount) {
    for (let i = lineNodes.length - 1; i >= plan.lineCount; i--) {
      lineNodes[i]!.remove();
    }
    lineNodes.length = plan.lineCount;
  }

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
    if (node.hasAttribute(HIDDEN_MARK)) continue;
    const input = findFirst(node, QTY_INPUT_SELECTORS);
    if (!(input instanceof HTMLInputElement)) continue;
    const domQty = Number.parseInt(input.value, 10);
    if (Number.isNaN(domQty)) continue;
    if (domQty > actualQuantities[i]!) return true;
  }
  return false;
}

// Sync native theme quantity inputs to authoritative cart values after reconcile. Skips gift rows
// hidden by applyGiftLineHiding — their qty (always 1) must not overwrite a visible buy row when
// DOM/cart index correlation is otherwise correct.
export function syncNativeInputs(
  itemsEl: HTMLElement | null,
  actualQuantities: readonly number[],
): void {
  if (itemsEl === null) return;
  const lineNodes = findLineNodes(itemsEl);
  if (lineNodes.length !== actualQuantities.length) return;
  for (let i = 0; i < lineNodes.length; i++) {
    const node = lineNodes[i]!;
    if (node.hasAttribute(HIDDEN_MARK)) continue;
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
