// Money formatting that MIRRORS the theme's own dynamic-price formatter (assets/global.js
// `formatPrice(cents, moneyString)` + `window.theme.settings.money_format`). Used ONLY to repaint a
// merged row's line total (a display value we compute client-side); Shopify + the liquid `money`
// filter remain authoritative everywhere else. Kept in exact parity with the theme so a merged
// total is visually indistinguishable from a theme-rendered one.
type ThemeMoneyWindow = Window & {
  readonly theme?: { readonly settings?: { readonly money_format?: string } };
  readonly Shopify?: { readonly locale?: string };
};

const AMOUNT_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/;

// The shop's money format string (e.g. `${{amount}}`, `{{amount_no_decimals}}円`). Falls back to a
// plain `${{amount}}` when the theme global is absent (older/other themes) so a total still renders.
export function themeMoneyFormat(): string {
  const fmt = (window as ThemeMoneyWindow).theme?.settings?.money_format;
  return fmt !== undefined && fmt !== '' ? fmt : '${{amount}}';
}

function themeLocale(): string | undefined {
  return (window as ThemeMoneyWindow).Shopify?.locale;
}

// Format integer minor units (cents) with the given money format string. Replicates the theme's
// `formatPrice` switch so decimals/separators match the liquid `money` filter for this shop.
export function formatMoney(cents: number, format: string = themeMoneyFormat()): string {
  const match = format.match(AMOUNT_PLACEHOLDER);
  const option = match !== null ? match[1] : 'amount';
  const amount = cents / 100;
  const locale = themeLocale();

  let value: string;
  switch (option) {
    case 'amount_no_decimals':
      value = String(Math.round(amount));
      break;
    case 'amount_with_comma_separator':
      value = amount.toFixed(2).replace('.', ',');
      break;
    case 'amount_no_decimals_with_comma_separator':
      value = new Intl.NumberFormat(locale).format(Math.round(amount)).replace(/\./g, ',');
      break;
    case 'amount':
    default:
      value = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
      break;
  }

  return format.replace(AMOUNT_PLACEHOLDER, value);
}
