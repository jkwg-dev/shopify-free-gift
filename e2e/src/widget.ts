// Page objects for the FGE perception UI (.fge-* nodes the widget renders) + the gift lines it writes
// into the real cart. A snapshot is scoped to a context: 'page' = the /cart page section (nodes NOT
// inside <cart-drawer>), 'drawer' = the cart drawer section. Interactions dispatch the same events the
// widget's handlers listen for (radio change / button click / checkbox change).
import { WebDriver } from 'selenium-webdriver';
import { evalAsync } from './browser.js';
import { getCart, numId } from './proxy.js';

export type CardSnap = {
  name: string;
  selected: boolean;
  status: string;
  unavailable: boolean;
  chips: { label: string; selected: boolean; disabled: boolean }[];
};
export type WidgetSnap = {
  present: boolean;
  headline: string;
  fillPct: number;
  steps: { tier: string; reached: boolean; current: boolean; label: string }[];
  chooserTitle: string | null;
  hint: string | null;
  declinePresent: boolean;
  declineChecked: boolean;
  cards: CardSnap[];
  pending: boolean;
};

// Scope expression: the CSS root for a context. 'page' → elements not inside a cart-drawer; we resolve
// that in JS by walking. We pass the context and filter in-page.
const SNAP_JS = `
  const context = arguments[0];
  const inDrawer = (el) => !!el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification');
  const pick = (sel) => Array.prototype.filter.call(document.querySelectorAll(sel), (el) =>
    context === 'drawer' ? inDrawer(el) : !inDrawer(el));
  const stepperWrap = pick('[data-fge-stepper]')[0] || null;
  const chooserWrap = pick('[data-fge-chooser]')[0] || null;
  const text = (el) => (el && el.textContent ? el.textContent.trim().replace(/\\s+/g, ' ') : '');
  const snap = {
    present: !!chooserWrap,
    headline: text(stepperWrap && stepperWrap.querySelector('.fge-headline')),
    fillPct: (() => {
      const f = stepperWrap && stepperWrap.querySelector('.fge-stepper__fill');
      if (!f) return -1;
      const w = f.style.width || '';
      const m = w.match(/([0-9.]+)%/); return m ? Number(m[1]) : -1;
    })(),
    steps: Array.prototype.map.call(stepperWrap ? stepperWrap.querySelectorAll('.fge-step') : [], (s) => ({
      tier: s.dataset.tier || '',
      reached: s.classList.contains('is-reached'),
      current: s.classList.contains('is-current'),
      label: text(s.querySelector('.fge-step__label')),
    })),
    chooserTitle: (() => {
      const t = chooserWrap && chooserWrap.querySelector('.fge-gift__title');
      return t ? text(t) : null;
    })(),
    hint: (() => {
      const h = chooserWrap && chooserWrap.querySelector('.fge-gift__hint');
      return h ? text(h) : null;
    })(),
    declinePresent: !!(chooserWrap && chooserWrap.querySelector('.fge-decline')),
    declineChecked: !!(chooserWrap && chooserWrap.querySelector('.fge-decline input') && chooserWrap.querySelector('.fge-decline input').checked),
    pending: !!(chooserWrap && chooserWrap.querySelector('.fge-gift.is-pending')),
    cards: Array.prototype.map.call(chooserWrap ? chooserWrap.querySelectorAll('.fge-card') : [], (card) => ({
      name: text(card.querySelector('.fge-card__name')),
      selected: card.classList.contains('is-selected'),
      status: text(card.querySelector('.fge-card__status')),
      unavailable: card.classList.contains('is-unavailable'),
      chips: Array.prototype.map.call(card.querySelectorAll('.fge-variant'), (b) => ({
        label: text(b),
        selected: b.classList.contains('is-selected'),
        disabled: !!b.disabled,
      })),
    })),
  };
  return snap;
`;

export async function readWidget(
  driver: WebDriver,
  context: 'page' | 'drawer' = 'page',
): Promise<WidgetSnap> {
  return evalAsync<WidgetSnap>(driver, `return (function(){ ${SNAP_JS} })();`, context);
}

export type GiftLine = { variantId: string; qty: number; finalLinePrice: number; title: string };

// The gift lines the widget put in the cart (marked _fge_gift). variantId as a GID for comparison to
// config option variantIds.
export async function giftLines(driver: WebDriver): Promise<GiftLine[]> {
  const cart = await getCart(driver);
  return cart.items
    .filter((it) => it.properties && it.properties['_fge_gift'] != null)
    .map((it) => ({
      variantId: `gid://shopify/ProductVariant/${it.variant_id}`,
      qty: it.quantity,
      finalLinePrice: it.final_line_price,
      title: it.title,
    }));
}

// A paid (non-gift) cart line for a given variant id, if present.
export async function paidLineFor(
  driver: WebDriver,
  variantId: string,
): Promise<{ qty: number; finalLinePrice: number } | null> {
  const cart = await getCart(driver);
  const id = numId(variantId);
  const line = cart.items.find(
    (it) => it.variant_id === id && !(it.properties && it.properties['_fge_gift'] != null),
  );
  return line ? { qty: line.quantity, finalLinePrice: line.final_line_price } : null;
}

// --- interactions (dispatch the events the widget's handlers listen for) -------------------------

// Click the OR product card radio whose product name contains `nameSubstr`. Returns true if found.
export async function chooseOrProduct(
  driver: WebDriver,
  nameSubstr: string,
  context: 'page' | 'drawer' = 'page',
): Promise<boolean> {
  return evalAsync<boolean>(
    driver,
    `const context = arguments[0], sub = (arguments[1]||'').toLowerCase();
     const inDrawer = (el) => !!el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification');
     const wrap = Array.prototype.filter.call(document.querySelectorAll('[data-fge-chooser]'), (el) => context === 'drawer' ? inDrawer(el) : !inDrawer(el))[0];
     if (!wrap) return false;
     const cards = wrap.querySelectorAll('.fge-card');
     for (const c of cards) {
       const nm = (c.querySelector('.fge-card__name')||{}).textContent || '';
       if (nm.toLowerCase().includes(sub)) {
         const radio = c.querySelector('input.fge-card__radio');
         if (radio) { radio.click(); return true; }
       }
     }
     return false;`,
    context,
    nameSubstr,
  );
}

// Click a variant chip (button) whose label contains `chipSubstr`, within a card matching cardSubstr
// (optional). Returns true if clicked.
export async function chooseVariantChip(
  driver: WebDriver,
  chipSubstr: string,
  context: 'page' | 'drawer' = 'page',
  cardSubstr?: string,
): Promise<boolean> {
  return evalAsync<boolean>(
    driver,
    `const context = arguments[0], chip = (arguments[1]||'').toLowerCase(), cardSub = (arguments[2]||'').toLowerCase();
     const inDrawer = (el) => !!el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification');
     const wrap = Array.prototype.filter.call(document.querySelectorAll('[data-fge-chooser]'), (el) => context === 'drawer' ? inDrawer(el) : !inDrawer(el))[0];
     if (!wrap) return false;
     const cards = wrap.querySelectorAll('.fge-card');
     for (const c of cards) {
       const nm = ((c.querySelector('.fge-card__name')||{}).textContent || '').toLowerCase();
       if (cardSub && !nm.includes(cardSub)) continue;
       for (const b of c.querySelectorAll('button.fge-variant')) {
         if ((b.textContent||'').toLowerCase().includes(chip) && !b.disabled) { b.click(); return true; }
       }
     }
     return false;`,
    context,
    chipSubstr,
    cardSubstr ?? '',
  );
}

// Toggle the "Add my free gift" checkbox to a desired state (addGift=true → checked/keep gift).
export async function setAddGift(
  driver: WebDriver,
  addGift: boolean,
  context: 'page' | 'drawer' = 'page',
): Promise<boolean> {
  return evalAsync<boolean>(
    driver,
    `const context = arguments[0], want = arguments[1];
     const inDrawer = (el) => !!el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification');
     const wrap = Array.prototype.filter.call(document.querySelectorAll('[data-fge-chooser]'), (el) => context === 'drawer' ? inDrawer(el) : !inDrawer(el))[0];
     if (!wrap) return false;
     const cb = wrap.querySelector('.fge-decline input');
     if (!cb) return false;
     if (cb.checked !== want) cb.click();
     return true;`,
    context,
    addGift,
  );
}

// Open the cart drawer (Dawn). Try the standard cart icon trigger; returns whether a drawer became active.
export async function openDrawer(driver: WebDriver): Promise<boolean> {
  return evalAsync<boolean>(
    driver,
    `const btn = document.querySelector('#cart-icon-bubble, a[href="/cart"], .header__icon--cart');
     if (btn) btn.click();
     await new Promise((r) => setTimeout(r, 600));
     const d = document.querySelector('cart-drawer, #CartDrawer, .drawer--cart');
     return !!(d && (d.classList.contains('active') || d.classList.contains('animate') || d.getAttribute('open') !== null));`,
  );
}
