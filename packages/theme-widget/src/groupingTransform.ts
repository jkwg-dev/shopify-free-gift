// Chooser-only DOM transform (theme-coupled, FAIL-OPEN). Consumes the pure GroupingPlan
// (cartGrouping.ts) and: (1) HIDES gift lines (the chooser is the sole gift representation),
// (2) merges split buy lines into a single interactive row, and (3) injects the merged +/−/delete
// stepper. PRESENTATION ONLY: issues NO cart write.
//
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

// --- selectors (Dawn first, then broader fallbacks for non-Dawn themes) --------------------------
const LINE_SELECTORS = [
  '.cart-item',
  '[id^="CartDrawer-Item-"]',
  '[id^="CartItem-"]',
  'cart-item',
  '.cart__row',
];
const TOTALS_SELECTORS = [
  '.cart-item__totals',
  '[class*="cart-item__price"]',
  '[class*="line-item__price"]',
  '[class*="cart-item__total"]',
];
const FINAL_PRICE_SELECTORS = ['.price--end', '.cart-item__final-price'];
const OLD_PRICE_SELECTORS = ['.cart-item__old-price'];
const PRICE_WRAPPER = '.cart-item__price-wrapper';
const QTY_CELL_SELECTORS = [
  '.cart-item__quantity',
  '[class*="cart-item__quantity"]',
  '[class*="cart-item__qty"]',
];
const QTY_INPUT_SELECTORS = [
  '.quantity__input',
  'input[name="updates[]"]',
  'input[name*="quantity" i]',
  'input[type="number"]',
];
const QTY_BUTTON_SELECTORS = ['.quantity__button', 'cart-remove-button', '.button--tertiary'];
const QTY_WIDGET_SELECTORS = [
  'quantity-input',
  '.quantity',
  '.cart-item__quantity-wrapper',
  '[class*="quantity-selector"]',
];
const REMOVE_SELECTORS = [
  'cart-remove-button',
  '.button--tertiary',
  '[id^="Remove-"]',
  'a[href*="/cart/change"]',
];

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

function diag(msg: string, ...data: unknown[]): void {
  console.warn(`[FGE] ${msg}`, ...data);
}

function findTotalsCell(node: HTMLElement): HTMLElement | null {
  for (const sel of TOTALS_SELECTORS) {
    const el = node.querySelector<HTMLElement>(sel);
    if (el !== null) return el;
  }
  return null;
}

function findQtyContainer(node: HTMLElement): HTMLElement {
  const named = findFirst(node, QTY_CELL_SELECTORS);
  if (named !== null) return named;
  const input = findFirst(node, QTY_INPUT_SELECTORS);
  if (input !== null) {
    const parent = input.parentElement;
    if (parent !== null && parent !== node) {
      diag('findQtyContainer: fallback to input parent', parent.tagName, parent.className);
      return parent;
    }
  }
  diag('findQtyContainer: no qty cell found, falling back to node', node.tagName, node.id);
  return node;
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

// Overwrite the line total in EVERY responsive totals cell (and the strikethrough, if any)
// with the merged sums. Leaves the per-UNIT price alone (it lives in .cart-item__details, not totals).
function setLineTotals(node: HTMLElement, sumFinal: number, sumOriginal: number): void {
  let found = false;
  for (const sel of TOTALS_SELECTORS) {
    const cells = node.querySelectorAll<HTMLElement>(sel);
    if (cells.length > 0) {
      cells.forEach((cell) => {
        const wrapper = cell.querySelector<HTMLElement>(PRICE_WRAPPER) ?? cell;
        const finalEl =
          findFirst(wrapper, FINAL_PRICE_SELECTORS) ??
          wrapper.querySelector<HTMLElement>('.price:not(.cart-item__old-price)') ??
          wrapper;
        reformatInPlace(finalEl, sumFinal);
        reformatInPlace(findFirst(wrapper, OLD_PRICE_SELECTORS), sumOriginal);
      });
      found = true;
      break;
    }
  }
  if (!found) diag('setLineTotals: no totals cell found in', node.tagName, node.id);
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

// Hide the native qty widget + per-line remove on a row (their write targets a SINGLE split key —
// defect #2). Keeps the qty CELL itself visible so we can inject our merged control.
function hideNativeStepper(node: HTMLElement): void {
  let hiddenCount = 0;
  for (const sel of [...QTY_WIDGET_SELECTORS, ...REMOVE_SELECTORS]) {
    node.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
      hiddenCount++;
    });
  }
  const input = findFirst(node, QTY_INPUT_SELECTORS);
  if (input instanceof HTMLInputElement) input.readOnly = true;

  if (hiddenCount === 0) {
    diag(
      'hideNativeStepper: no elements matched widget/remove selectors in',
      node.tagName,
      node.id,
      node.className,
    );
    // Fallback: find the qty input and hide its parent container's children (the native +/- buttons
    // and input wrapper) so only the FGE stepper remains visible in the cell.
    if (input !== null) {
      const container = findQtyContainer(node);
      if (container !== node) {
        for (const child of Array.from(container.children)) {
          if (child instanceof HTMLElement && !child.classList.contains('fge-merged-stepper')) {
            child.style.display = 'none';
            child.setAttribute('aria-hidden', 'true');
            hiddenCount++;
          }
        }
        // Also hide direct text/button siblings of the input that aren't wrapped
        if (hiddenCount === 0 && input.parentElement === container) {
          container.querySelectorAll<HTMLElement>('button, a').forEach((el) => {
            el.style.display = 'none';
            el.setAttribute('aria-hidden', 'true');
          });
          input.style.display = 'none';
        }
        diag(
          'hideNativeStepper: fallback hid',
          hiddenCount,
          'children in',
          container.tagName,
          container.className,
        );
      }
    }
  }
}

export type MergedQtyChangeResult = {
  readonly applied: boolean;
  readonly qty: number;
  readonly finalPrice: number;
  readonly originalPrice: number;
};

export type MergedQtyChange = (
  writableKeys: readonly string[],
  targetQty: number,
) => Promise<MergedQtyChangeResult>;

// Inject the interactive merged +/−/delete stepper into a SPLIT buy row's qty cell, wired to the
// absolute-target write callback (§4). The widget OWNS the displayed qty + price (ⓥ1): a click
// optimistically repaints this row to the new target T immediately (a raw cart/update.js does not make
// Dawn redraw), then `onChange` performs the atomic write + a tier re-validate. T is ABSOLUTE, never a
// delta: "+" → q+1, "−" → q−1 (q==1 ⇒ T=0 deletes, matching Dawn), "remove" → T=0. Buttons disable
// while a write is in flight so compounding clicks can't compute T off a stale base (§5.1).
function injectMergedStepper(
  node: HTMLElement,
  qty: number,
  finalLinePrice: number,
  originalLinePrice: number,
  writableKeys: readonly string[],
  onChange: MergedQtyChange,
): void {
  hideNativeStepper(node);
  node.querySelector('.fge-merged-stepper')?.remove();
  const cell = findQtyContainer(node);
  diag('injectMergedStepper: cell=', cell.tagName, cell.className, 'node=', node.tagName, node.id);

  let perUnitFinal = qty > 0 ? finalLinePrice / qty : 0;
  let perUnitOriginal = qty > 0 ? originalLinePrice / qty : 0;

  const wrap = document.createElement('div');
  wrap.className = 'fge fge-merged-stepper';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Quantity');

  const mkBtn = (act: 'dec' | 'inc' | 'del', label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = act === 'del' ? 'fge-merged-stepper__remove' : 'fge-merged-stepper__btn';
    b.setAttribute('data-fge-act', act);
    b.setAttribute('aria-label', label);
    return b;
  };
  const dec = mkBtn('dec', 'Decrease quantity');
  dec.innerHTML =
    '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12H20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const inc = mkBtn('inc', 'Increase quantity');
  inc.innerHTML =
    '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4V12M12 12V20M12 12H4M12 12H20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const del = mkBtn('del', 'Remove item');
  del.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const qtyEl = document.createElement('span');
  qtyEl.className = 'fge-merged-stepper__qty';
  qtyEl.setAttribute('aria-live', 'polite');
  qtyEl.textContent = String(qty);
  const inner = document.createElement('div');
  inner.className = 'fge-merged-stepper__wrapper';
  inner.append(dec, qtyEl, inc);
  wrap.append(inner, del);
  cell.append(wrap);

  let current = qty;
  let inFlight = false;
  const setDisabled = (d: boolean): void => {
    for (const b of [dec, inc, del]) b.disabled = d;
    wrap.classList.toggle('is-busy', d);
  };
  // Repaint the row to an absolute quantity q: qty text + line total, hiding the whole row at q==0.
  const repaint = (q: number): void => {
    qtyEl.textContent = String(q);
    if (q === 0) {
      node.style.display = 'none';
      node.setAttribute('data-fge-merged-removed', '');
    } else {
      node.style.display = '';
      node.removeAttribute('data-fge-merged-removed');
      setLineTotals(node, Math.round(perUnitFinal * q), Math.round(perUnitOriginal * q));
    }
  };
  const onAct = (target: number): void => {
    if (inFlight) return; // §5.1: ignore compounding clicks while a write is in flight
    inFlight = true;
    setDisabled(true);
    const prev = current; // pre-click state, for a self-contained rollback on failure (B.1)
    current = Math.max(0, target);
    // Optimistic widget-owned repaint (ⓥ1): qty + line total reflect T at once; siblings were already
    // hidden when the row was grouped. A delete (T==0) hides the whole interactive row.
    repaint(current);
    Promise.resolve(onChange(writableKeys, current))
      .then((result) => {
        if (!result.applied) {
          current = prev;
          repaint(prev);
        } else {
          // Authoritative: sync from the post-write cart (kills stale-base drift / off-by-one).
          current = result.qty;
          if (current > 0) {
            perUnitFinal = result.finalPrice / current;
            perUnitOriginal = result.originalPrice / current;
          }
          repaint(current);
        }
      })
      .finally(() => {
        inFlight = false;
        // Re-enable if the row still exists (a tier-change re-render replaces the node, leaving it stale).
        if (node.isConnected) setDisabled(false);
      });
  };
  dec.addEventListener('click', (e) => {
    e.stopPropagation();
    onAct(current - 1);
  });
  inc.addEventListener('click', (e) => {
    e.stopPropagation();
    onAct(current + 1);
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    onAct(0);
  });
}

export type GroupingTransformOptions = {
  readonly onMergedQtyChange?: MergedQtyChange | undefined;
};

// Reset ALL FGE-applied state on every line node so the next apply starts from a clean slate.
// This is what makes the transform self-healing: a buy row wrongly hidden by a stale plan is
// un-hidden before the current plan re-applies.
function resetRows(lineNodes: HTMLElement[]): void {
  for (const node of lineNodes) {
    node.style.display = '';
    node.removeAttribute(HIDDEN_MARK);
    node.removeAttribute('data-fge-merged-removed');
    node.querySelector('.fge-merged-stepper')?.remove();
    // Restore native stepper elements that hideNativeStepper set display:none on.
    for (const sel of [...QTY_WIDGET_SELECTORS, ...REMOVE_SELECTORS]) {
      node.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        el.style.display = '';
        el.removeAttribute('aria-hidden');
      });
    }
    const input = findFirst(node, QTY_INPUT_SELECTORS);
    if (input instanceof HTMLInputElement) {
      input.readOnly = false;
      input.style.pointerEvents = '';
    }
  }
}

// Apply the chooser-only layout to one theme items container. Returns true if it applied, false if
// it failed open. Gift lines (gets + lingering) are hidden — the chooser is the sole gift
// representation. Split buy lines are merged; the FGE stepper is injected on all buy rows when
// opts.onMergedQtyChange is provided. Self-healing: every pass resets ALL prior hides then re-applies
// from the CURRENT plan, so a wrongly-hidden buy row never persists.
export function applyTwoGroupLayout(
  itemsEl: HTMLElement | null,
  plan: GroupingPlan,
  opts: GroupingTransformOptions,
): boolean {
  if (itemsEl === null) return false;

  const lineNodes = findLineNodes(itemsEl);
  diag('applyTwoGroupLayout entry:', {
    lineNodes: lineNodes.length,
    planLineCount: plan.lineCount,
    hasGifts: plan.hasGifts,
    buys: plan.buys.length,
    gets: plan.gets.length,
    lingering: plan.lingering.length,
    hasMergedQtyChange: opts.onMergedQtyChange !== undefined,
    containerTag: itemsEl.tagName,
    containerId: itemsEl.id,
    lineNodeInfo: lineNodes
      .slice(0, 3)
      .map((n) => `${n.tagName}#${n.id}.${n.className.slice(0, 50)}`),
  });

  // FAIL OPEN: nothing to transform, or the rendered list doesn't match the plan from /cart.js.
  if (plan.lineCount === 0 || lineNodes.length !== plan.lineCount) {
    diag(
      'applyTwoGroupLayout: FAIL OPEN — lineCount mismatch',
      lineNodes.length,
      '≠',
      plan.lineCount,
    );
    return false;
  }

  // FAIL OPEN (before mutating): a split buy row whose canonical node has NO line-total cell would
  // leave a stale total contradicting the subtotal — bail to the untouched theme list instead.
  for (const row of plan.buys) {
    if (!row.split) continue;
    const keep = row.interactiveIndex === null ? null : lineNodes[row.interactiveIndex];
    if (keep == null || findTotalsCell(keep) === null) {
      diag(
        'applyTwoGroupLayout: FAIL OPEN — split row has no totals cell',
        keep?.tagName,
        keep?.id,
      );
      return false;
    }
  }

  // RESET: clear ALL prior hides, marks, and injected steppers so no stale state persists.
  resetRows(lineNodes);

  // Mark on the custom-element host (cart-drawer-items / cart-items) so the FOUC mask CSS can gate on
  // it; falls back to itemsEl if no host is found (e.g. a non-Dawn theme).
  (itemsEl.closest('cart-drawer-items, cart-items') ?? itemsEl).setAttribute(MARK, '');

  // --- buy rows: merge splits + inject stepper ---
  // Section O: when gifts exist, inject the FGE merged stepper on ALL buy rows (including unsplit
  // n=1 rows) so the native stepper + per-line remove are never exposed. An unsplit row has a
  // single writableKey; the atomic cart/update.js with one key is trivially correct. When there are
  // no gifts, leave unsplit rows on Dawn's native stepper (no deadlock risk without a gift).
  const needsMergedOnAll = plan.hasGifts && opts.onMergedQtyChange !== undefined;
  const buyIndexes = new Set<number>();
  let steppersInjected = 0;
  for (const row of plan.buys) {
    if (row.interactiveIndex !== null) buyIndexes.add(row.interactiveIndex);
    const keep = row.interactiveIndex === null ? null : lineNodes[row.interactiveIndex];
    if (keep != null) {
      if (row.split) {
        setLineTotals(keep, row.controllableFinalPrice, row.controllableOriginalPrice);
      }
      if ((row.split || needsMergedOnAll) && opts.onMergedQtyChange !== undefined) {
        injectMergedStepper(
          keep,
          row.controllableQuantity,
          row.controllableFinalPrice,
          row.controllableOriginalPrice,
          row.writableKeys,
          opts.onMergedQtyChange,
        );
        steppersInjected++;
      } else if (row.split) {
        showMergedQtyReadOnly(keep, row.controllableQuantity);
      }
    }
    for (const hideIdx of row.hideIndexes) {
      buyIndexes.add(hideIdx);
      const sib = lineNodes[hideIdx];
      if (sib != null) {
        sib.style.display = 'none';
        sib.setAttribute(HIDDEN_MARK, '');
      }
    }
  }

  // --- gift lines: hide entirely (the chooser is the sole gift representation) ---
  for (const ref of plan.gets) {
    const node = lineNodes[ref.index];
    if (node != null) {
      node.style.display = 'none';
      node.setAttribute(HIDDEN_MARK, '');
    }
  }
  for (const ref of plan.lingering) {
    const node = lineNodes[ref.index];
    if (node != null) {
      node.style.display = 'none';
      node.setAttribute(HIDDEN_MARK, '');
    }
  }

  // Final invariant: every buy row MUST be visible. If any ended up hidden (e.g. a stale plan
  // applied on a prior pass, or a stepper repaint set display:none during a qty-0 delete), correct
  // it and log a warning so regressions are visible.
  for (const row of plan.buys) {
    if (row.interactiveIndex === null) continue;
    const node = lineNodes[row.interactiveIndex];
    if (node != null && node.style.display === 'none' && !node.hasAttribute(HIDDEN_MARK)) {
      node.style.display = '';
      diag('buy row was wrongly hidden, corrected', { variant: row.variantId });
    }
  }

  diag('applyTwoGroupLayout done:', {
    steppersInjected,
    giftsHidden: plan.gets.length + plan.lingering.length,
    mergedSteppersInDOM: itemsEl.querySelectorAll('.fge-merged-stepper').length,
  });

  return true;
}

// Sync native theme quantity inputs to authoritative cart values. Called after a reconcile when the
// theme may have rendered a stale requested qty (e.g. add qty 4 with only 1 in stock → theme shows
// 4, actual cart has 1). Only touches inputs outside our merged stepper (those are already synced).
export function syncNativeInputs(
  itemsEl: HTMLElement | null,
  actualQuantities: readonly number[],
): void {
  if (itemsEl === null) return;
  const lineNodes = findLineNodes(itemsEl);
  if (lineNodes.length !== actualQuantities.length) return;
  for (let i = 0; i < lineNodes.length; i++) {
    const node = lineNodes[i]!;
    if (node.querySelector('.fge-merged-stepper') !== null) continue;
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
