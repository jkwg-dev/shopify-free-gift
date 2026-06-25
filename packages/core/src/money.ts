// Money in a single, already-resolved currency. Market resolution and FX conversion
// happen upstream (see CLAUDE.md "Decision: tier thresholds across markets"); core only
// ever compares amounts that are already in the same currency.
//
// Amounts are integer minor units (e.g. cents) to avoid floating-point drift, so a
// one-minor-unit difference at a tier boundary is exact.

export type Money = {
  readonly amountMinor: number;
  readonly currency: string;
};

export class CurrencyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new RangeError(`Money amount must be an integer minor-unit value, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function multiplyMoney(m: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new RangeError(`Money multiplier must be an integer quantity, got ${factor}`);
  }
  return { amountMinor: m.amountMinor * factor, currency: m.currency };
}

/** Negative if a < b, zero if equal, positive if a > b. Throws on currency mismatch. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
}

export function isAtLeast(a: Money, b: Money): boolean {
  return compareMoney(a, b) >= 0;
}
