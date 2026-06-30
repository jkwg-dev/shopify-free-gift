/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyGiftLineHiding,
  shouldSkipNativeQtySync,
  syncNativeInputs,
} from './groupingTransform.js';
import type { GroupingPlan, GiftLineRef } from './cartGrouping.js';

function plan(over: Partial<GroupingPlan>): GroupingPlan {
  const gets = over.gets ?? [];
  const lingering = over.lingering ?? [];
  return {
    gets,
    lingering,
    hasGifts: gets.length > 0 || lingering.length > 0,
    lineCount: over.lineCount ?? 0,
    ...over,
  };
}

function buildDawnItems(count: number): HTMLElement {
  const container = document.createElement('div');
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.id = `CartDrawer-Item-${i + 1}`;

    const qtyCell = document.createElement('div');
    qtyCell.className = 'cart-item__quantity';
    const input = document.createElement('input');
    input.className = 'quantity__input';
    input.type = 'number';
    input.value = '1';
    qtyCell.appendChild(input);
    row.appendChild(qtyCell);
    container.appendChild(row);
  }
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('applyGiftLineHiding', () => {
  it('hides gets and lingering; buy rows stay visible', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    const giftRef: GiftLineRef = { index: 1, key: 'k1', variantId: 200 };
    const p = plan({
      gets: [giftRef],
      lineCount: 2,
    });

    expect(applyGiftLineHiding(itemsEl, p)).toBe(true);

    const rows = itemsEl.querySelectorAll('.cart-item');
    expect((rows[0] as HTMLElement).style.display).toBe('');
    expect((rows[1] as HTMLElement).style.display).toBe('none');
    expect(rows[1]!.hasAttribute('data-fge-gift-hidden')).toBe(true);
  });

  it('leaves all rows visible when there are no gifts', () => {
    const itemsEl = buildDawnItems(1);
    document.body.appendChild(itemsEl);

    expect(applyGiftLineHiding(itemsEl, plan({ lineCount: 1 }))).toBe(true);
    expect((itemsEl.querySelector('.cart-item') as HTMLElement).style.display).toBe('');
  });

  it('removes stale DOM nodes when DOM has more items than cart.js', () => {
    const itemsEl = buildDawnItems(3);
    document.body.appendChild(itemsEl);

    const p = plan({
      gets: [{ index: 0, key: 'k0', variantId: 100 }],
      lineCount: 2,
    });

    expect(applyGiftLineHiding(itemsEl, p)).toBe(true);
    expect(itemsEl.querySelectorAll('.cart-item')).toHaveLength(2);
  });

  it('self-heals: a row wrongly hidden by a stale plan is un-hidden when gifts move', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    applyGiftLineHiding(
      itemsEl,
      plan({
        gets: [{ index: 0, key: 'k0', variantId: 100 }],
        lineCount: 2,
      }),
    );

    applyGiftLineHiding(
      itemsEl,
      plan({
        gets: [{ index: 1, key: 'k1', variantId: 200 }],
        lineCount: 2,
      }),
    );

    const rows = itemsEl.querySelectorAll('.cart-item');
    expect((rows[0] as HTMLElement).style.display).toBe('');
    expect((rows[1] as HTMLElement).style.display).toBe('none');
  });

  it('fails open when DOM has fewer nodes than cart.js', () => {
    const itemsEl = buildDawnItems(1);
    document.body.appendChild(itemsEl);

    expect(
      applyGiftLineHiding(
        itemsEl,
        plan({
          gets: [{ index: 1, key: 'k1', variantId: 200 }],
          lineCount: 2,
        }),
      ),
    ).toBe(false);
  });
});

describe('syncNativeInputs', () => {
  it('syncs native inputs to authoritative quantities', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    syncNativeInputs(itemsEl, [3, 2]);

    const inputs = itemsEl.querySelectorAll<HTMLInputElement>('.quantity__input');
    expect(inputs[0]!.value).toBe('3');
    expect(inputs[1]!.value).toBe('2');
  });

  it('does not overwrite visible buy inputs from hidden gift rows', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);
    const rows = itemsEl.querySelectorAll<HTMLElement>('.cart-item');
    rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value = '2';
    rows[1]!.setAttribute('data-fge-gift-hidden', '');
    rows[1]!.style.display = 'none';

    syncNativeInputs(itemsEl, [2, 1]);

    expect(rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value).toBe('2');
    expect(rows[1]!.querySelector<HTMLInputElement>('.quantity__input')!.value).toBe('1');
  });
});

describe('shouldSkipNativeQtySync', () => {
  it('returns true when a visible row is optimistically ahead of cart.js', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);
    itemsEl.querySelector<HTMLInputElement>('.quantity__input')!.value = '2';

    expect(shouldSkipNativeQtySync(itemsEl, [1, 1])).toBe(true);
  });

  it('returns false when visible rows match or lag cart.js (authoritative sync safe)', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);
    itemsEl.querySelector<HTMLInputElement>('.quantity__input')!.value = '1';

    expect(shouldSkipNativeQtySync(itemsEl, [1, 1])).toBe(false);
    expect(shouldSkipNativeQtySync(itemsEl, [2, 1])).toBe(false);
  });

  it('ignores hidden gift rows when comparing', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);
    const rows = itemsEl.querySelectorAll<HTMLElement>('.cart-item');
    rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value = '1';
    rows[1]!.setAttribute('data-fge-gift-hidden', '');
    rows[1]!.querySelector<HTMLInputElement>('.quantity__input')!.value = '9';

    expect(shouldSkipNativeQtySync(itemsEl, [1, 1])).toBe(false);
  });
});
