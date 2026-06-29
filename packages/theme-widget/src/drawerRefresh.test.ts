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

describe('replaceDrawerFooter', () => {
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

    // Footer was replaced.
    const subtotal = document.querySelector('.totals__subtotal-value');
    expect(subtotal?.textContent).toBe('$200.00');

    // Items were NOT replaced.
    const items = document.querySelectorAll('.cart-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('Buy item A');
    expect(items[1]?.textContent).toBe('Gift line B');
  });

  it('falls back to finding footer inside #CartDrawer-Body when top-level fails', () => {
    document.body.innerHTML = `
      <div id="CartDrawer-Body">
        <div class="items-wrapper">Items here</div>
        <div class="cart-drawer__footer">OLD footer</div>
      </div>
    `;

    const sectionHtml = `
      <div class="other-wrapper">
        <div id="CartDrawer-Body">
          <div class="items-wrapper">New items</div>
          <div class="cart-drawer__footer">NEW footer</div>
        </div>
      </div>
    `;

    const result = replaceDrawerFooter(sectionHtml);
    expect(result).toBe(true);
    expect(document.querySelector('.cart-drawer__footer')?.textContent).toBe('NEW footer');
    expect(document.querySelector('.items-wrapper')?.textContent).toBe('Items here');
  });

  it('returns false when no footer selector matches', () => {
    document.body.innerHTML = '<div>no footer here</div>';
    const result = replaceDrawerFooter('<div>also no footer</div>');
    expect(result).toBe(false);
  });
});

describe('stampAuthoritativeCart', () => {
  it('overwrites subtotal from cart.total_price', () => {
    document.body.innerHTML = `
      <div class="cart-drawer__footer">
        <span class="totals__subtotal-value">$999.99</span>
      </div>
    `;
    stampAuthoritativeCart({ total_price: 121497, item_count: 5 });
    expect(document.querySelector('.totals__subtotal-value')?.textContent).toBe('$1,214.97');
  });

  it('overwrites badge count from cart.item_count', () => {
    document.body.innerHTML = `
      <div class="cart-count-bubble">
        <span aria-hidden="true">4</span>
      </div>
    `;
    stampAuthoritativeCart({ total_price: 0, item_count: 5 });
    expect(document.querySelector('.cart-count-bubble span[aria-hidden="true"]')?.textContent).toBe(
      '5',
    );
  });

  it('overwrites data-cart-subtotal and data-cart-count selectors', () => {
    document.body.innerHTML = `
      <span data-cart-subtotal>$50.00</span>
      <span data-cart-count>2</span>
    `;
    stampAuthoritativeCart({ total_price: 7500, item_count: 3 });
    expect(document.querySelector('[data-cart-subtotal]')?.textContent).toBe('$75.00');
    expect(document.querySelector('[data-cart-count]')?.textContent).toBe('3');
  });
});
