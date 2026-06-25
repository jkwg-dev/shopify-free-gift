import { addMoney, money, multiplyMoney, type Money } from './money.js';

// A cart line as posted to /validate. `isGift` is set by the storefront when it auto-adds
// a campaign gift line (tagged via a line-item property). Core trusts that tag to exclude
// gift lines from qualification — it does not re-derive gift status from campaign config.
export type CartLine = {
  readonly variantId: string;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly isGift: boolean;
};

// The qualifying subtotal EXCLUDES gift lines. A gift sits in the cart at full price until
// the discount code applies at checkout, so counting it would let a gift bump the cart into
// a higher tier — a gift must never help qualify for itself or a better tier (CLAUDE.md).
export function computeQualifyingSubtotal(lines: readonly CartLine[], currency: string): Money {
  let subtotal = money(0, currency);
  for (const line of lines) {
    if (line.isGift) {
      continue;
    }
    // addMoney asserts the line is priced in `currency`, surfacing any upstream FX mistake.
    subtotal = addMoney(subtotal, multiplyMoney(line.unitPrice, line.quantity));
  }
  return subtotal;
}
