import type { Money } from '@free-gift-engine/core';

// The parse/format boundary between Shopify Money (decimal string + currencyCode) and core's
// integer minor units. The minor-unit exponent is CURRENCY-SPECIFIC (CLAUDE.md): most are 2,
// but JPY/KRW are 0 and BHD/KWD are 3. Using a hardcoded x100 would make a JPY threshold off
// by 100x, so the exponent is always derived from the currency here.

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currencyCode: string): number {
  const code = currencyCode.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return 0;
  }
  if (THREE_DECIMAL_CURRENCIES.has(code)) {
    return 3;
  }
  return 2;
}

// Parse a Shopify decimal amount string (e.g. "50.00", "50", "5.000") into integer minor
// units, exactly (no floating point). Rejects precision finer than the currency allows.
export function decimalToMinorUnits(amount: string, currencyCode: string): number {
  const exponent = currencyExponent(currencyCode);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (match === null) {
    throw new RangeError(`Invalid decimal amount "${amount}" for ${currencyCode}`);
  }
  const [, sign, intPart, rawFraction = ''] = match;
  let fraction = rawFraction;
  if (fraction.length > exponent) {
    const excess = fraction.slice(exponent);
    if (/[^0]/.test(excess)) {
      throw new RangeError(
        `Amount "${amount}" has more precision than ${currencyCode} allows (${exponent} dp)`,
      );
    }
    fraction = fraction.slice(0, exponent);
  }
  const minorString = `${intPart}${fraction.padEnd(exponent, '0')}`;
  const magnitude = Number(minorString);
  return sign === '-' ? -magnitude : magnitude;
}

// Format integer minor units into a Shopify decimal amount string using the currency's
// exponent (e.g. 5000 USD -> "50.00", 50 JPY -> "50", 5000 KWD -> "5.000").
export function minorUnitsToDecimal(minorUnits: number, currencyCode: string): string {
  const exponent = currencyExponent(currencyCode);
  const sign = minorUnits < 0 ? '-' : '';
  const digits = Math.abs(minorUnits)
    .toString()
    .padStart(exponent + 1, '0');
  if (exponent === 0) {
    return `${sign}${digits}`;
  }
  const cut = digits.length - exponent;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export function moneyToDecimalString(money: Money): string {
  return minorUnitsToDecimal(money.amountMinor, money.currency);
}

// Convert a BASE-currency amount to a presentment-currency amount using Shopify's market FX rate
// (the SAME rate Shopify applies to the BXGY minimum at checkout; sourced client-side from
// window.Shopify.currency.rate). `rate` multiplies the MAJOR base amount to the MAJOR presentment
// amount (Shopify's convention: 570 * 0.7187 = 409.64); the exponent DIFFERENCE re-expresses the
// result in presentment minor units (so JPY/KRW with 0 decimals are handled), and we round UP
// (ceil) to the presentment minor unit. Rounding up guarantees the derived threshold is >= Shopify's
// converted minimum, so /validate can only UNDER-offer at the boundary, never over-offer (no broken
// promise from rounding/timing skew). The caller validates `rate` is finite and > 0; this is pure.
export function convertBaseToPresentmentCeil(
  base: Money,
  presentmentCurrency: string,
  rate: number,
): Money {
  const shift = currencyExponent(presentmentCurrency) - currencyExponent(base.currency);
  const scaled = base.amountMinor * rate;
  // Apply the exponent shift by integer divide/multiply (NOT * 10**-n, whose 0.01 constant is
  // inexact and could mis-ceil an exact result by one minor unit).
  const factor = 10 ** Math.abs(shift);
  const presentmentMinor = Math.ceil(shift >= 0 ? scaled * factor : scaled / factor);
  return { amountMinor: presentmentMinor, currency: presentmentCurrency };
}
