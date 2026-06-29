/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  overwritePriceFromMinorUnits,
  stampAuthoritativeCart,
  replaceDrawerFooter,
} from './drawerRefresh.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// overwritePriceFromMinorUnits
// ---------------------------------------------------------------------------
describe('overwritePriceFromMinorUnits', () => {
  it('overwrites a USD-style price preserving the $ prefix', () => {
    const el = document.createElement('span');
    el.textContent = '$125.00';
    overwritePriceFromMinorUnits(el, 9999);
    expect(el.textContent).toBe('$99.99');
  });

  it('preserves CA$ prefix and comma grouping', () => {
    const el = document.createElement('span');
    el.textContent = 'CA$1,234.50';
    overwritePriceFromMinorUnits(el, 200000);
    expect(el.textContent).toBe('CA$2,000.00');
  });

  it('no-ops on text with no number', () => {
    const el = document.createElement('span');
    el.textContent = 'Free';
    overwritePriceFromMinorUnits(el, 500);
    expect(el.textContent).toBe('Free');
  });

  it('handles a single-digit price', () => {
    const el = document.createElement('span');
    el.textContent = '$5';
    overwritePriceFromMinorUnits(el, 9);
    expect(el.textContent).toBe('$9');
  });
});

// ---------------------------------------------------------------------------
// replaceDrawerFooter — stock Dawn fixture
// ---------------------------------------------------------------------------
describe('replaceDrawerFooter (stock Dawn)', () => {
  it('replaces only the footer, leaving items untouched', () => {
    document.body.innerHTML = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item" id="CartDrawer-Item-1">Buy item A</div>
          <div class="cart-item" id="CartDrawer-Item-2">Gift line B</div>
        </cart-drawer-items>
        <div class="cart-drawer__footer">
          <span class="totals__subtotal-value">$100.00</span>
        </div>
      </div>
    `;

    const sectionHtml = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item" id="CartDrawer-Item-1">REPLACED item A</div>
        </cart-drawer-items>
        <div class="cart-drawer__footer">
          <span class="totals__subtotal-value">$200.00</span>
        </div>
      </div>
    `;

    const result = replaceDrawerFooter(sectionHtml);
    expect(result).toBe(true);

    const subtotal = document.querySelector('.totals__subtotal-value');
    expect(subtotal?.textContent).toBe('$200.00');

    const items = document.querySelectorAll('.cart-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('Buy item A');
    expect(items[1]?.textContent).toBe('Gift line B');
  });

  it('returns false when no summary/footer selector matches', () => {
    document.body.innerHTML = '<div>no footer here</div>';
    const result = replaceDrawerFooter('<div>also no footer</div>');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// replaceDrawerFooter — CUSTOM THEME fixture (greenteegolfshop)
// ---------------------------------------------------------------------------
describe('replaceDrawerFooter (custom theme)', () => {
  it('replaces .cart-drawer__summary, items list byte-for-byte unchanged', () => {
    document.body.innerHTML = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item" id="CartDrawer-Item-1">Buy item A</div>
          <div class="cart-item" id="CartDrawer-Item-2">Gift line B</div>
        </cart-drawer-items>
        <div class="cart-drawer__summary">
          <form id="CartDrawer-FormSummary" class="cart-drawer__form-summary">
            <div id="cart-summary">
              <span class="cart-drawer__total-price">$809.98 CAD</span>
            </div>
          </form>
        </div>
      </div>
    `;

    const itemsBefore = document.querySelector('cart-drawer-items')!.innerHTML;

    const sectionHtml = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item" id="CartDrawer-Item-1">STALE item</div>
        </cart-drawer-items>
        <div class="cart-drawer__summary">
          <form id="CartDrawer-FormSummary" class="cart-drawer__form-summary">
            <div id="cart-summary">
              <span class="cart-drawer__total-price">$1,214.97 CAD</span>
            </div>
          </form>
        </div>
      </div>
    `;

    const result = replaceDrawerFooter(sectionHtml);
    expect(result).toBe(true);

    expect(document.querySelector('.cart-drawer__total-price')?.textContent).toBe('$1,214.97 CAD');

    expect(document.querySelector('cart-drawer-items')!.innerHTML).toBe(itemsBefore);
  });

  it('never falls back to replacing #CartDrawer-Body even if summary is absent', () => {
    document.body.innerHTML = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item">Original item</div>
        </cart-drawer-items>
      </div>
    `;
    const sectionHtml = `
      <div id="CartDrawer-Body">
        <cart-drawer-items>
          <div class="cart-item">REPLACED item</div>
        </cart-drawer-items>
      </div>
    `;

    const result = replaceDrawerFooter(sectionHtml);
    expect(result).toBe(false);
    expect(document.querySelector('.cart-item')?.textContent).toBe('Original item');
  });
});

// ---------------------------------------------------------------------------
// stampAuthoritativeCart — stock Dawn fixture
// ---------------------------------------------------------------------------
describe('stampAuthoritativeCart (stock Dawn)', () => {
  it('overwrites .totals__subtotal-value and .cart-count-bubble badge', () => {
    document.body.innerHTML = `
      <div class="cart-drawer__footer">
        <span class="totals__subtotal-value">$999.99</span>
      </div>
      <div class="cart-count-bubble">
        <span aria-hidden="true">4</span>
      </div>
    `;
    const r = stampAuthoritativeCart({ total_price: 121497, item_count: 5 });
    expect(document.querySelector('.totals__subtotal-value')?.textContent).toBe('$1,214.97');
    expect(document.querySelector('.cart-count-bubble span[aria-hidden="true"]')?.textContent).toBe(
      '5',
    );
    expect(r.subtotalTargetsFound).toBeGreaterThan(0);
    expect(r.badgeTargetsFound).toBeGreaterThan(0);
  });

  it('overwrites data-cart-subtotal and data-cart-count selectors', () => {
    document.body.innerHTML = `
      <span data-cart-subtotal>$50.00</span>
      <span data-cart-count>2</span>
    `;
    const r = stampAuthoritativeCart({ total_price: 7500, item_count: 3 });
    expect(document.querySelector('[data-cart-subtotal]')?.textContent).toBe('$75.00');
    expect(document.querySelector('[data-cart-count]')?.textContent).toBe('3');
    expect(r.subtotalTargetsFound).toBe(1);
    expect(r.badgeTargetsFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stampAuthoritativeCart — CUSTOM THEME fixture (greenteegolfshop)
// ---------------------------------------------------------------------------
describe('stampAuthoritativeCart (custom theme)', () => {
  it('overwrites .cart-drawer__total-price subtotal', () => {
    document.body.innerHTML = `
      <div class="cart-drawer__summary">
        <form id="CartDrawer-FormSummary" class="cart-drawer__form-summary">
          <div id="cart-summary">
            <span class="cart-drawer__total-price">$809.98 CAD</span>
          </div>
        </form>
      </div>
    `;
    const r = stampAuthoritativeCart({ total_price: 121497, item_count: 5 });
    expect(document.querySelector('.cart-drawer__total-price')?.textContent).toBe('$1,214.97 CAD');
    expect(r.subtotalTargetsFound).toBeGreaterThan(0);
  });

  it('overwrites BOTH .cart-count-badge (header) and .cart-drawer__title-counter (drawer)', () => {
    document.body.innerHTML = `
      <span class="cart-count-badge">3</span>
      <span class="cart-drawer__title-counter">3</span>
    `;
    const r = stampAuthoritativeCart({ total_price: 0, item_count: 5 });
    expect(document.querySelector('.cart-count-badge')?.textContent).toBe('5');
    expect(document.querySelector('.cart-drawer__title-counter')?.textContent).toBe('5');
    expect(r.badgeTargetsFound).toBe(2);
  });

  it('returns zero counts when no elements match (selector miss diagnostic)', () => {
    document.body.innerHTML = '<div>empty page</div>';
    const r = stampAuthoritativeCart({ total_price: 100, item_count: 1 });
    expect(r.subtotalTargetsFound).toBe(0);
    expect(r.badgeTargetsFound).toBe(0);
  });
});
