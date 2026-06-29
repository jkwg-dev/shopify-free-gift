// Extracted helpers for refreshing the cart drawer's footer + badge from section rendering responses
// and stamping authoritative cart.js values. Separated from storefront.ts (which auto-inits) so
// they can be unit-tested without triggering storefront side effects.
//
// Selector lists are ORDERED: custom-theme (greenteegolfshop) first, stock Dawn after, so the live
// theme hits on the first pass and stock Dawn still works as a fallback.

// Summary/footer selectors — the block containing the subtotal + checkout button.
// Custom theme uses .cart-drawer__summary; stock Dawn uses .cart-drawer__footer.
export const DRAWER_SUMMARY_SELECTORS = [
  '.cart-drawer__summary',
  '#cart-summary',
  '#CartDrawer-FormSummary',
  '.cart-drawer__footer',
  '[data-cart-footer]',
  '.cart__footer',
  '.drawer__footer',
];

// Subtotal price element selectors (custom theme first, then stock Dawn).
const SUBTOTAL_SELECTORS = [
  '.cart-drawer__total-price',
  '.totals__subtotal-value',
  '.cart-drawer__subtotal .price',
  '.totals__total-value',
  '[data-cart-subtotal]',
];

// Badge count element selectors (custom theme first, then stock Dawn).
const BADGE_SELECTORS = [
  '.cart-count-badge',
  '.cart-drawer__title-counter',
  '.cart-count-bubble span[aria-hidden="true"]',
  '[data-cart-count]',
];

function warn(msg: string, ...data: unknown[]): void {
  console.warn(`[FGE-DRAWERFIX] ${msg}`, ...data);
}

// Overwrite a price element's numeric text from an authoritative minor-unit integer, preserving the
// node's currency symbol/format. Same in-place approach used by setLineTotals in groupingTransform.
export function overwritePriceFromMinorUnits(el: HTMLElement, minorUnits: number): void {
  const text = el.textContent ?? '';
  const m = text.match(/\d[\d.,\u00A0\u202F' ]*\d|\d/);
  if (m === null) return;
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
  const intText = decimals > 0 ? token.slice(0, decPos) : token;
  const gMatch = intText.match(/[.,\u00A0\u202F' ]/);
  const groupSep = gMatch !== null ? gMatch[0] : decimalSep === '.' ? ',' : '.';
  const fixed = (minorUnits / Math.pow(10, decimals)).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? '' : fixed.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const num = decimals > 0 ? `${grouped}${decimalSep}${fracPart}` : grouped;
  el.textContent = text.replace(token, num);
}

export type StampResult = {
  readonly subtotalTargetsFound: number;
  readonly badgeTargetsFound: number;
};

// Stamp the authoritative cart.js total_price into all subtotal elements and item_count into all
// badge elements, so the displayed numbers never contradict the real cart — even if the section HTML
// was fetched before the discount fully settled. Returns counts so callers can log misses.
export function stampAuthoritativeCart(cart: {
  total_price: number;
  item_count: number;
}): StampResult {
  let subtotalTargetsFound = 0;
  for (const sel of SUBTOTAL_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      overwritePriceFromMinorUnits(el, cart.total_price);
      subtotalTargetsFound++;
    });
  }

  let badgeTargetsFound = 0;
  for (const sel of BADGE_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.textContent = String(cart.item_count);
      badgeTargetsFound++;
    });
  }

  if (subtotalTargetsFound === 0) {
    warn('stamp: no subtotal target found', SUBTOTAL_SELECTORS);
  }
  if (badgeTargetsFound === 0) {
    warn('stamp: no badge target found', BADGE_SELECTORS);
  }

  return { subtotalTargetsFound, badgeTargetsFound };
}

// Replace ONLY the summary/footer block in the drawer section HTML, leaving the items container
// untouched. Returns true if a summary block was replaced. Never falls back to replacing the whole
// body — if no summary selector matches, returns false and relies on stampAuthoritativeCart.
export function replaceDrawerFooter(drawerHtml: string): boolean {
  const parsed = new DOMParser().parseFromString(drawerHtml, 'text/html');
  for (const sel of DRAWER_SUMMARY_SELECTORS) {
    const newBlock = parsed.querySelector(sel);
    const liveBlock = document.querySelector(sel);
    if (newBlock !== null && liveBlock !== null) {
      liveBlock.innerHTML = newBlock.innerHTML;
      return true;
    }
  }
  warn('footer: no summary target found', DRAWER_SUMMARY_SELECTORS);
  return false;
}
