/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { applyTwoGroupLayout, syncNativeInputs } from './groupingTransform.js';
import type { GroupingPlan, BuyRow, GiftLineRef } from './cartGrouping.js';

function buyRow(over: Partial<BuyRow> & Pick<BuyRow, 'variantId'>): BuyRow {
  return {
    controllableQuantity: 1,
    controllableFinalPrice: 1000,
    controllableOriginalPrice: 1000,
    interactiveIndex: 0,
    hideIndexes: [],
    readOnlyIndexes: [],
    writableKeys: ['k0'],
    split: false,
    ...over,
  };
}

function plan(over: Partial<GroupingPlan>): GroupingPlan {
  const gets = over.gets ?? [];
  const lingering = over.lingering ?? [];
  const buys = over.buys ?? [];
  return {
    gets,
    lingering,
    buys,
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
    const qtyWidget = document.createElement('quantity-input');
    qtyWidget.className = 'quantity';
    const input = document.createElement('input');
    input.className = 'quantity__input';
    input.type = 'number';
    input.value = '1';
    qtyWidget.appendChild(input);
    const decBtn = document.createElement('button');
    decBtn.className = 'quantity__button';
    decBtn.textContent = '-';
    const incBtn = document.createElement('button');
    incBtn.className = 'quantity__button';
    incBtn.textContent = '+';
    qtyWidget.appendChild(decBtn);
    qtyWidget.appendChild(incBtn);
    qtyCell.appendChild(qtyWidget);

    const removeBtn = document.createElement('cart-remove-button');
    removeBtn.textContent = 'Remove';
    qtyCell.appendChild(removeBtn);

    const totalsCell = document.createElement('div');
    totalsCell.className = 'cart-item__totals';
    const priceWrap = document.createElement('div');
    priceWrap.className = 'cart-item__price-wrapper';
    const finalPrice = document.createElement('span');
    finalPrice.className = 'price--end';
    finalPrice.textContent = '$10.00';
    priceWrap.appendChild(finalPrice);
    totalsCell.appendChild(priceWrap);

    row.appendChild(qtyCell);
    row.appendChild(totalsCell);
    container.appendChild(row);
  }
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('applyTwoGroupLayout — merged stepper on unsplit buy rows (Section O)', () => {
  it('injects merged stepper on an unsplit buy row when hasGifts is true', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    const giftRef: GiftLineRef = { index: 1, key: 'k1', variantId: 200 };
    const p = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0, writableKeys: ['k0'] })],
      gets: [giftRef],
      lineCount: 2,
    });

    const onChange = vi.fn();
    const result = applyTwoGroupLayout(itemsEl, p, { onMergedQtyChange: onChange });

    expect(result).toBe(true);

    // The unsplit buy row should have a merged stepper injected.
    const rows = itemsEl.querySelectorAll('.cart-item');
    const buyNode = rows[0]!;
    expect(buyNode.querySelector('.fge-merged-stepper')).not.toBeNull();

    // The native qty widget should be hidden.
    const nativeWidget = buyNode.querySelector('quantity-input') as HTMLElement;
    expect(nativeWidget.style.display).toBe('none');

    // The gift row should be hidden.
    const giftNode = rows[1]! as HTMLElement;
    expect(giftNode.style.display).toBe('none');
  });

  it('does NOT inject merged stepper on unsplit buy rows when hasGifts is false', () => {
    const itemsEl = buildDawnItems(1);
    document.body.appendChild(itemsEl);

    const p = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0 })],
      gets: [],
      lineCount: 1,
    });

    const onChange = vi.fn();
    const result = applyTwoGroupLayout(itemsEl, p, { onMergedQtyChange: onChange });

    expect(result).toBe(true);

    // No merged stepper on the unsplit row without gifts.
    const rows = itemsEl.querySelectorAll('.cart-item');
    expect(rows[0]!.querySelector('.fge-merged-stepper')).toBeNull();
  });

  it('injects merged stepper on EVERY buy row (split and unsplit) when hasGifts is true', () => {
    const itemsEl = buildDawnItems(4);
    document.body.appendChild(itemsEl);

    const giftRef: GiftLineRef = { index: 3, key: 'k3', variantId: 300 };
    const p = plan({
      buys: [
        buyRow({
          variantId: 100,
          interactiveIndex: 0,
          hideIndexes: [1],
          writableKeys: ['k0', 'k1'],
          split: true,
          controllableQuantity: 5,
          controllableFinalPrice: 5000,
          controllableOriginalPrice: 5000,
        }),
        buyRow({ variantId: 200, interactiveIndex: 2, writableKeys: ['k2'] }),
      ],
      gets: [giftRef],
      lineCount: 4,
    });

    const onChange = vi.fn();
    const result = applyTwoGroupLayout(itemsEl, p, { onMergedQtyChange: onChange });

    expect(result).toBe(true);

    const rows = itemsEl.querySelectorAll('.cart-item');
    // Split buy row (index 0) has merged stepper.
    expect(rows[0]!.querySelector('.fge-merged-stepper')).not.toBeNull();
    // Hidden split sibling (index 1).
    expect((rows[1] as HTMLElement).style.display).toBe('none');
    // Unsplit buy row (index 2) also has merged stepper because hasGifts is true.
    expect(rows[2]!.querySelector('.fge-merged-stepper')).not.toBeNull();
    // Gift row (index 3) hidden.
    expect((rows[3] as HTMLElement).style.display).toBe('none');
  });
});

describe('applyTwoGroupLayout — self-healing (stale-plan regression)', () => {
  it('a buy row wrongly hidden by a stale plan is un-hidden when the correct plan applies', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    // Stale plan: row 0 is a gift, row 1 is a buy.
    const stalePlan = plan({
      buys: [buyRow({ variantId: 200, interactiveIndex: 1 })],
      gets: [{ index: 0, key: 'k0', variantId: 100 }],
      lineCount: 2,
    });
    applyTwoGroupLayout(itemsEl, stalePlan, {});

    const rows = itemsEl.querySelectorAll('.cart-item');
    expect((rows[0] as HTMLElement).style.display).toBe('none'); // gift hidden

    // Current plan: row 0 is a buy, row 1 is a gift (cart composition changed).
    const currentPlan = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0 })],
      gets: [{ index: 1, key: 'k1', variantId: 200 }],
      lineCount: 2,
    });
    applyTwoGroupLayout(itemsEl, currentPlan, {});

    // Row 0 must be visible (buy), row 1 must be hidden (gift).
    expect((rows[0] as HTMLElement).style.display).toBe('');
    expect((rows[1] as HTMLElement).style.display).toBe('none');
  });

  it('re-applying the same plan re-injects stepper and hides correctly (no idempotency skip)', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    const giftRef: GiftLineRef = { index: 1, key: 'k1', variantId: 200 };
    const p = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0, writableKeys: ['k0'] })],
      gets: [giftRef],
      lineCount: 2,
    });

    const onChange = vi.fn();
    applyTwoGroupLayout(itemsEl, p, { onMergedQtyChange: onChange });
    applyTwoGroupLayout(itemsEl, p, { onMergedQtyChange: onChange });

    const rows = itemsEl.querySelectorAll('.cart-item');
    expect(rows[0]!.querySelector('.fge-merged-stepper')).not.toBeNull();
    expect((rows[0] as HTMLElement).style.display).toBe('');
    expect((rows[1] as HTMLElement).style.display).toBe('none');
    // Only one stepper per row (not doubled).
    expect(rows[0]!.querySelectorAll('.fge-merged-stepper')).toHaveLength(1);
  });

  it('native stepper is restored when gifts disappear and merged stepper is no longer needed', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    // First apply: gifts exist, merged stepper injected, native hidden.
    const withGifts = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0, writableKeys: ['k0'] })],
      gets: [{ index: 1, key: 'k1', variantId: 200 }],
      lineCount: 2,
    });
    applyTwoGroupLayout(itemsEl, withGifts, { onMergedQtyChange: vi.fn() });

    const row0 = itemsEl.querySelectorAll('.cart-item')[0]!;
    expect(row0.querySelector('.fge-merged-stepper')).not.toBeNull();
    expect((row0.querySelector('quantity-input') as HTMLElement).style.display).toBe('none');

    // Second apply: no gifts, only 1 buy row. Native stepper should be restored.
    const noGifts = plan({
      buys: [buyRow({ variantId: 100, interactiveIndex: 0 })],
      gets: [],
      lineCount: 1,
    });
    // Re-build items to match new lineCount (1 row).
    const newItems = buildDawnItems(1);
    document.body.innerHTML = '';
    document.body.appendChild(newItems);
    applyTwoGroupLayout(newItems, noGifts, { onMergedQtyChange: vi.fn() });

    const newRow = newItems.querySelectorAll('.cart-item')[0]!;
    expect(newRow.querySelector('.fge-merged-stepper')).toBeNull();
    expect((newRow.querySelector('quantity-input') as HTMLElement).style.display).toBe('');
  });
});

describe('syncNativeInputs', () => {
  it('syncs native inputs to authoritative quantities, skipping merged steppers', () => {
    const itemsEl = buildDawnItems(2);
    document.body.appendChild(itemsEl);

    // Simulate a merged stepper on row 0.
    const mergedStepper = document.createElement('div');
    mergedStepper.className = 'fge-merged-stepper';
    itemsEl.querySelectorAll('.cart-item')[0]!.appendChild(mergedStepper);

    syncNativeInputs(itemsEl, [3, 2]);

    const inputs = itemsEl.querySelectorAll<HTMLInputElement>('.quantity__input');
    // Row 0 has a merged stepper — native input NOT touched.
    expect(inputs[0]!.value).toBe('1');
    // Row 1 has no merged stepper — synced to authoritative value.
    expect(inputs[1]!.value).toBe('2');
  });
});
