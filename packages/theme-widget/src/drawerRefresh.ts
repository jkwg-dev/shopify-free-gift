// Extracted helpers for refreshing the cart drawer's footer + badge from section rendering responses
// and stamping authoritative cart.js values. Separated from storefront.ts (which auto-inits) so
// they can be unit-tested without triggering storefront side effects.

// Footer selectors tried in order — Dawn first, then broader fallbacks.
export const DRAWER_FOOTER_SELECTORS = [
  '.cart-drawer__footer',
  '[data-cart-footer]',
  '.cart__footer',
  '.drawer__footer',
];

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

// Stamp the authoritative cart.js total_price into all subtotal elements and item_count into all
// badge elements, so the displayed numbers never contradict the real cart — even if the section HTML
// was fetched before the discount fully settled.
export function stampAuthoritativeCart(cart: { total_price: number; item_count: number }): void {
  const subtotalSelectors = [
    '.totals__subtotal-value',
    '.cart-drawer__subtotal .price',
    '.totals__total-value',
    '[data-cart-subtotal]',
  ];
  for (const sel of subtotalSelectors) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      overwritePriceFromMinorUnits(el, cart.total_price);
    });
  }
  const badgeDots = document.querySelectorAll<HTMLElement>(
    '.cart-count-bubble span[aria-hidden="true"], [data-cart-count]',
  );
  badgeDots.forEach((el) => {
    el.textContent = String(cart.item_count);
  });
}

// Replace ONLY the footer block in the drawer section HTML, leaving the items container untouched.
// Returns true if a footer was replaced.
export function replaceDrawerFooter(drawerHtml: string): boolean {
  const parsed = new DOMParser().parseFromString(drawerHtml, 'text/html');
  let replaced = false;
  for (const sel of DRAWER_FOOTER_SELECTORS) {
    const newFooter = parsed.querySelector(sel);
    const liveFooter = document.querySelector(sel);
    if (newFooter !== null && liveFooter !== null) {
      liveFooter.innerHTML = newFooter.innerHTML;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    const bodySelectors = ['#CartDrawer-Body', '[data-cart-body]'];
    for (const bodySel of bodySelectors) {
      const newBody = parsed.querySelector(bodySel);
      const liveBody = document.querySelector(bodySel);
      if (newBody !== null && liveBody !== null) {
        for (const fSel of DRAWER_FOOTER_SELECTORS) {
          const innerFooter = newBody.querySelector(fSel);
          const liveInner = liveBody.querySelector(fSel);
          if (innerFooter !== null && liveInner !== null) {
            liveInner.innerHTML = innerFooter.innerHTML;
            replaced = true;
            break;
          }
        }
        if (replaced) break;
      }
    }
  }
  return replaced;
}
