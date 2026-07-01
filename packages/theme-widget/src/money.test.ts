/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney, themeMoneyFormat } from './money.js';

type MutableThemeWindow = {
  theme?: { settings?: { money_format?: string } };
  Shopify?: { locale?: string };
};

function setTheme(moneyFormat: string | undefined, locale = 'en'): void {
  const w = window as unknown as MutableThemeWindow;
  w.theme = moneyFormat === undefined ? {} : { settings: { money_format: moneyFormat } };
  w.Shopify = { locale };
}

afterEach(() => {
  const w = window as unknown as MutableThemeWindow;
  delete w.theme;
  delete w.Shopify;
});

describe('themeMoneyFormat', () => {
  it('reads the shop money format from the theme global', () => {
    setTheme('${{amount}}');
    expect(themeMoneyFormat()).toBe('${{amount}}');
  });

  it('falls back to a plain dollar format when the theme global is absent', () => {
    setTheme(undefined);
    expect(themeMoneyFormat()).toBe('${{amount}}');
  });
});

describe('formatMoney', () => {
  it('formats amount with two decimals and thousands separators (the common $ case)', () => {
    setTheme('${{amount}}');
    expect(formatMoney(30000)).toBe('$300.00');
    expect(formatMoney(123456)).toBe('$1,234.56');
  });

  it('supports amount_no_decimals (zero-decimal currencies)', () => {
    setTheme('{{amount_no_decimals}}円');
    expect(formatMoney(150000)).toBe('1500円');
  });

  it('preserves surrounding literal characters in the format string', () => {
    setTheme('CA${{amount}} CAD');
    expect(formatMoney(29997)).toBe('CA$299.97 CAD');
  });
});
