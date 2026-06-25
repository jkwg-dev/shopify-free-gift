import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  CurrencyMismatchError,
  isAtLeast,
  money,
  multiplyMoney,
} from './money.js';

describe('money', () => {
  it('constructs from integer minor units', () => {
    expect(money(4999, 'USD')).toEqual({ amountMinor: 4999, currency: 'USD' });
  });

  it('rejects a non-integer amount', () => {
    expect(() => money(49.99, 'USD')).toThrow(RangeError);
  });

  it('adds amounts of the same currency', () => {
    expect(addMoney(money(100, 'USD'), money(250, 'USD'))).toEqual(money(350, 'USD'));
  });

  it('multiplies by an integer quantity', () => {
    expect(multiplyMoney(money(150, 'USD'), 3)).toEqual(money(450, 'USD'));
  });

  it('rejects a non-integer multiplier', () => {
    expect(() => multiplyMoney(money(150, 'USD'), 1.5)).toThrow(RangeError);
  });

  it('compares amounts of the same currency', () => {
    expect(compareMoney(money(100, 'USD'), money(250, 'USD'))).toBeLessThan(0);
    expect(compareMoney(money(250, 'USD'), money(100, 'USD'))).toBeGreaterThan(0);
    expect(compareMoney(money(100, 'USD'), money(100, 'USD'))).toBe(0);
  });

  it('treats equality as "at least"', () => {
    expect(isAtLeast(money(100, 'USD'), money(100, 'USD'))).toBe(true);
    expect(isAtLeast(money(101, 'USD'), money(100, 'USD'))).toBe(true);
    expect(isAtLeast(money(99, 'USD'), money(100, 'USD'))).toBe(false);
  });

  it('throws CurrencyMismatchError when currencies differ', () => {
    expect(() => addMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
  });
});
