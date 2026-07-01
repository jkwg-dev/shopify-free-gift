/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MERGE_KEYS_ATTR,
  MERGE_PRIMARY_ATTR,
  applyGiftLineHiding,
  applyLineMerge,
  shouldSkipNativeQtySync,
  syncNativeInputs,
} from './groupingTransform.js';
import type { GroupingPlan, GiftLineRef } from './cartGrouping.js';
import type { MergePlan } from './lineMerge.js';

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

// Rows mirroring line-item.liquid enough for the merge transform: a quantity input, +/- buttons, and
// a line-TOTAL price element (`.cart-item__actions--price > .cart-item__price`).
function buildMergeRows(count: number): HTMLElement {
  const container = document.createElement('div');
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.id = `CartDrawer-Item-${i + 1}`;
    row.innerHTML = `
      <div class="cart-item__quantity">
        <button class="quantity__button" name="decrement" type="button"></button>
        <input class="quantity__input" type="number" name="updates[]" min="0" max="99" value="1" data-index="${i + 1}">
        <button class="quantity__button" name="increment" type="button"></button>
      </div>
      <div class="cart-item__actions--price"><span class="cart-item__price">$0.00</span></div>`;
    container.appendChild(row);
  }
  return container;
}

const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

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

  it('fails open WITHOUT removing nodes when DOM has more items than the plan (stale plan)', () => {
    const itemsEl = buildDawnItems(3);
    document.body.appendChild(itemsEl);

    const p = plan({
      gets: [{ index: 0, key: 'k0', variantId: 100 }],
      lineCount: 2,
    });

    // A stale (smaller) plan must NOT delete real rows — that caused the "only the first row shows"
    // drawer flash. Stay masked (false) and leave every node in place for the authoritative refetch.
    expect(applyGiftLineHiding(itemsEl, p)).toBe(false);
    expect(itemsEl.querySelectorAll('.cart-item')).toHaveLength(3);
    for (const row of itemsEl.querySelectorAll<HTMLElement>('.cart-item')) {
      expect(row.style.display).toBe('');
    }
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

describe('applyLineMerge', () => {
  const mergePlan = (over: Partial<MergePlan['groups'][number]>): MergePlan => ({
    groups: [
      {
        primaryIndex: 0,
        hiddenIndices: [1],
        totalQuantity: 3,
        totalFinalPrice: 30000,
        keys: ['buy', 'marked'],
        ...over,
      },
    ],
  });

  it('hides the sibling, rolls qty + line total into the primary, and stamps the group keys', () => {
    const itemsEl = buildMergeRows(2);
    document.body.appendChild(itemsEl);

    expect(applyLineMerge(itemsEl, mergePlan({}), 2, fmt)).toBe(true);

    const rows = itemsEl.querySelectorAll<HTMLElement>('.cart-item');
    expect(rows[0]!.style.display).toBe('');
    expect(rows[1]!.style.display).toBe('none');
    expect(rows[1]!.hasAttribute('data-fge-merge-hidden')).toBe(true);

    expect(rows[0]!.hasAttribute(MERGE_PRIMARY_ATTR)).toBe(true);
    expect(JSON.parse(rows[0]!.getAttribute(MERGE_KEYS_ATTR)!)).toEqual(['buy', 'marked']);
    expect(rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value).toBe('3');
    expect(
      rows[0]!.querySelector('.cart-item__actions--price .cart-item__price')!.textContent,
    ).toBe('$300.00');
  });

  it('fails open (no changes) on a node/line count mismatch', () => {
    const itemsEl = buildMergeRows(3);
    document.body.appendChild(itemsEl);

    expect(applyLineMerge(itemsEl, mergePlan({}), 2, fmt)).toBe(false);
    for (const row of itemsEl.querySelectorAll<HTMLElement>('.cart-item')) {
      expect(row.style.display).toBe('');
      expect(row.hasAttribute(MERGE_PRIMARY_ATTR)).toBe(false);
    }
  });

  it('is idempotent: an empty plan un-hides a previously merged sibling and clears the marks', () => {
    const itemsEl = buildMergeRows(2);
    document.body.appendChild(itemsEl);

    applyLineMerge(itemsEl, mergePlan({}), 2, fmt);
    applyLineMerge(itemsEl, { groups: [] }, 2, fmt);

    const rows = itemsEl.querySelectorAll<HTMLElement>('.cart-item');
    expect(rows[1]!.style.display).toBe('');
    expect(rows[1]!.hasAttribute('data-fge-merge-hidden')).toBe(false);
    expect(rows[0]!.hasAttribute(MERGE_PRIMARY_ATTR)).toBe(false);
    expect(rows[0]!.hasAttribute(MERGE_KEYS_ATTR)).toBe(false);
  });

  it('disables the increment button when the group total reaches the input max', () => {
    const itemsEl = buildMergeRows(2);
    document.body.appendChild(itemsEl);
    itemsEl
      .querySelectorAll<HTMLInputElement>('.quantity__input')
      .forEach((input) => input.setAttribute('max', '3'));

    applyLineMerge(itemsEl, mergePlan({ totalQuantity: 3 }), 2, fmt);

    const inc = itemsEl
      .querySelector('.cart-item')!
      .querySelector<HTMLButtonElement>('.quantity__button[name="increment"]')!;
    expect(inc.disabled).toBe(true);
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

  it('does not overwrite a merge-primary input (it holds the group total, not the per-line qty)', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);
    const rows = itemsEl.querySelectorAll<HTMLElement>('.cart-item');
    rows[0]!.setAttribute('data-fge-merge-primary', '');
    rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value = '3';
    rows[1]!.setAttribute('data-fge-merge-hidden', '');

    syncNativeInputs(itemsEl, [2, 1]);

    expect(rows[0]!.querySelector<HTMLInputElement>('.quantity__input')!.value).toBe('3');
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
