import { readFileSync } from 'node:fs';
import { GIFT_LINE_PROPERTY } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import {
  cartValidationsGenerateRun,
  GIFT_GATE_MESSAGE,
  hasUnqualifiedGiftLine,
  type GiftGateLine,
} from './run.js';

const gift = (lineTotalAmount: string): GiftGateLine => ({ isFreeGiftLine: true, lineTotalAmount });
const paid = (lineTotalAmount: string): GiftGateLine => ({
  isFreeGiftLine: false,
  lineTotalAmount,
});

describe('hasUnqualifiedGiftLine', () => {
  it('allows a free gift line (exactly 0)', () => {
    expect(hasUnqualifiedGiftLine([gift('0'), gift('0.00')])).toBe(false);
  });

  it('blocks a gift line reverted to full price (> 0)', () => {
    expect(hasUnqualifiedGiftLine([gift('729.95')])).toBe(true);
  });

  it('never blocks on non-gift lines (normal + Kite-only carts) — even a $0 non-gift line', () => {
    // A $0 line WITHOUT the _fge_gift marker (e.g. a Kite BOGO freebie) must not block.
    expect(hasUnqualifiedGiftLine([paid('60.00'), paid('0.00')])).toBe(false);
  });

  it('allows an AND tier when every required gift is free', () => {
    expect(hasUnqualifiedGiftLine([gift('0.00'), gift('0.00'), paid('1200.00')])).toBe(false);
  });

  it('blocks an AND tier when one required gift reverted to paid', () => {
    expect(hasUnqualifiedGiftLine([gift('0.00'), gift('749.95'), paid('1200.00')])).toBe(true);
  });

  it('uses exact-zero — no sub-cent residue tolerated', () => {
    expect(hasUnqualifiedGiftLine([gift('0.00')])).toBe(false);
    expect(hasUnqualifiedGiftLine([gift('0.01')])).toBe(true);
  });

  it('does not block on a non-numeric amount (fail-open per line)', () => {
    expect(hasUnqualifiedGiftLine([gift('')])).toBe(false);
  });
});

describe('cartValidationsGenerateRun', () => {
  const line = (amount: string, isGift: boolean) => ({
    cost: { totalAmount: { amount } },
    isFreeGift: isGift ? { value: '1' } : null,
  });

  it('blocks with a single $.cart error when an FGE gift line is no longer free', () => {
    const result = cartValidationsGenerateRun({
      cart: { lines: [line('60.00', false), line('729.95', true)] },
    });
    expect(result).toEqual({
      operations: [
        { validationAdd: { errors: [{ message: GIFT_GATE_MESSAGE, target: '$.cart' }] } },
      ],
    });
  });

  it('allows when every FGE gift line is free', () => {
    const result = cartValidationsGenerateRun({
      cart: { lines: [line('60.00', false), line('0.00', true)] },
    });
    expect(result).toEqual({ operations: [] });
  });

  it('allows a cart with no FGE gift lines, including a $0 Kite line', () => {
    const result = cartValidationsGenerateRun({
      cart: { lines: [line('60.00', false), line('0.00', false)] },
    });
    expect(result).toEqual({ operations: [] });
  });
});

describe('gift-line marker parity', () => {
  it('run.graphql keys off the same property as core GIFT_LINE_PROPERTY (no drift)', () => {
    const query = readFileSync(new URL('./run.graphql', import.meta.url), 'utf8');
    expect(GIFT_LINE_PROPERTY).toBe('_fge_gift');
    expect(query).toContain(`attribute(key: "${GIFT_LINE_PROPERTY}")`);
  });
});
