import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import {
  convertBaseToPresentmentCeil,
  currencyExponent,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  moneyToDecimalString,
} from './money.js';

describe('currencyExponent', () => {
  it('is 2 for ordinary currencies', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('eur')).toBe(2);
  });

  it('is 0 for zero-decimal currencies (JPY, KRW)', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
  });

  it('is 3 for three-decimal currencies (KWD, BHD)', () => {
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
  });
});

describe('decimalToMinorUnits', () => {
  it('parses a 2-decimal currency', () => {
    expect(decimalToMinorUnits('50.00', 'USD')).toBe(5000);
    expect(decimalToMinorUnits('0.05', 'USD')).toBe(5);
  });

  it('parses a ZERO-decimal currency without the 100x error', () => {
    // The trap: a hardcoded x100 would turn ¥50 into 5000. The exponent must come from JPY.
    expect(decimalToMinorUnits('50', 'JPY')).toBe(50);
    expect(decimalToMinorUnits('50.00', 'JPY')).toBe(50);
    expect(decimalToMinorUnits('1500', 'KRW')).toBe(1500);
  });

  it('parses a 3-decimal currency', () => {
    expect(decimalToMinorUnits('5.000', 'KWD')).toBe(5000);
  });

  it('rejects precision finer than the currency allows', () => {
    expect(() => decimalToMinorUnits('50.001', 'USD')).toThrow(RangeError);
    expect(() => decimalToMinorUnits('50.5', 'JPY')).toThrow(RangeError);
  });

  it('rejects a malformed amount', () => {
    expect(() => decimalToMinorUnits('abc', 'USD')).toThrow(RangeError);
  });
});

describe('minorUnitsToDecimal', () => {
  it('formats each currency by its exponent', () => {
    expect(minorUnitsToDecimal(5000, 'USD')).toBe('50.00');
    expect(minorUnitsToDecimal(5, 'USD')).toBe('0.05');
    expect(minorUnitsToDecimal(50, 'JPY')).toBe('50');
    expect(minorUnitsToDecimal(5000, 'KWD')).toBe('5.000');
  });

  it('round-trips with decimalToMinorUnits', () => {
    for (const [minor, code] of [
      [12345, 'USD'],
      [50, 'JPY'],
      [5000, 'KWD'],
    ] as const) {
      expect(decimalToMinorUnits(minorUnitsToDecimal(minor, code), code)).toBe(minor);
    }
  });
});

describe('moneyToDecimalString', () => {
  it('formats a core Money using its currency exponent', () => {
    expect(moneyToDecimalString(money(5000, 'USD'))).toBe('50.00');
    expect(moneyToDecimalString(money(50, 'JPY'))).toBe('50');
  });
});

describe('convertBaseToPresentmentCeil', () => {
  it('converts same-exponent currencies (CAD->USD) and ceils to the cent', () => {
    // CA$500.00 (50000 minor) x 0.71866446 = 35933.223 minor -> ceil 35934 = US$359.34.
    expect(convertBaseToPresentmentCeil(money(50000, 'CAD'), 'USD', 0.71866446)).toEqual(
      money(35934, 'USD'),
    );
  });

  it('handles a zero-decimal presentment currency (CAD->JPY), ceiling to whole yen', () => {
    // CA$500.00 x 110.567 = JPY 55283.5 -> ceil 55284 (exponent shift 0-2 re-expresses to yen).
    expect(convertBaseToPresentmentCeil(money(50000, 'CAD'), 'JPY', 110.567)).toEqual(
      money(55284, 'JPY'),
    );
    // An exact result is not bumped up by the ceil.
    expect(convertBaseToPresentmentCeil(money(50000, 'CAD'), 'JPY', 110)).toEqual(
      money(55000, 'JPY'),
    );
  });

  it('is identity-ish for rate 1 in the same currency', () => {
    expect(convertBaseToPresentmentCeil(money(5000, 'USD'), 'USD', 1)).toEqual(money(5000, 'USD'));
  });

  it('rounds UP at a sub-unit boundary (never under the converted floor)', () => {
    // 5000 x 1.4001 = 7000.5 -> ceil 7001 (we are at worst one minor unit stricter than exact).
    expect(convertBaseToPresentmentCeil(money(5000, 'USD'), 'CAD', 1.4001)).toEqual(
      money(7001, 'CAD'),
    );
    // A clean multiple is not inflated by floating noise.
    expect(convertBaseToPresentmentCeil(money(5000, 'USD'), 'CAD', 1.4)).toEqual(
      money(7000, 'CAD'),
    );
  });
});
