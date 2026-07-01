// In-browser Shopify + App Proxy helpers. Everything runs in the PAGE context (same origin) so the
// preview session cookie is present and Shopify signs the /apps/free-gift/* proxy calls exactly as it
// does for the real widget. /config + /validate auto-attach the LIVE market context (currency + FX
// rate from window.Shopify.currency) so multi-currency runs need no extra plumbing.
import { WebDriver } from 'selenium-webdriver';
import { evalAsync } from './browser.js';

export type Money = { readonly amountMinor: number; readonly currency: string };

export type CartItem = {
  key: string;
  variant_id: number;
  quantity: number;
  title: string;
  final_line_price: number;
  original_line_price: number;
  properties: Record<string, unknown> | null;
  discounts: { title?: string; amount?: number }[];
};
export type Cart = {
  items: CartItem[];
  currency: string;
  item_count: number;
  total_price: number;
  total_discount?: number;
  items_subtotal_price?: number;
};

export type GiftOption = {
  optionId: string;
  variantId: string;
  productId: string;
  productLabel?: string;
  variantLabel: string;
  available: boolean;
};
export type Tier = {
  tierId: string;
  position: number;
  threshold: Money;
  gift:
    | { kind: 'OR'; options: GiftOption[] }
    | { kind: 'AND'; gifts: Omit<GiftOption, 'optionId'>[] };
};
export type CampaignConfig =
  | { status: 'inactive' }
  | { status: 'active'; currency: string; declineEnabled: boolean; tiers: Tier[] };

export type ValidateResult =
  | {
      status: 'gift';
      tierId: string;
      code: string;
      giftVariantIds: string[];
      subtotal: Money;
      appliedThreshold?: Money;
    }
  | { status: 'no-gift'; reason: string; subtotal?: Money }
  | { status: string; [k: string]: unknown };

export type MarketContext = { active: string; rate: string | null };

const numId = (variantId: string): number => Number(variantId.split('/').pop());

// Read the live presentment currency + base->presentment FX rate the theme exposes (Shopify updates
// it on a market switch). The widget reads the SAME source, so our expectations match what it enforces.
export async function marketContext(driver: WebDriver): Promise<MarketContext> {
  return evalAsync<MarketContext>(
    driver,
    `const c = (window.Shopify && window.Shopify.currency) || {};
     return { active: c.active || '', rate: (c.rate != null ? String(c.rate) : null) };`,
  );
}

export async function getCart(driver: WebDriver): Promise<Cart> {
  return evalAsync<Cart>(
    driver,
    `const r = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
     return await r.json();`,
  );
}

export async function clearCart(driver: WebDriver): Promise<void> {
  await evalAsync<void>(
    driver,
    `await fetch('/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } });`,
  );
}

// Add a variant (numeric id) at quantity, optionally with line-item properties. Returns the raw status
// so callers can assert on a 422 (e.g. an unpublished/OOS gift). Does NOT set _fge_gift unless asked —
// a shopper add must stay unmarked (paid-duplicate rule).
export async function addToCart(
  driver: WebDriver,
  variantId: number,
  quantity: number,
  properties?: Record<string, string>,
): Promise<{ status: number; ok: boolean }> {
  return evalAsync<{ status: number; ok: boolean }>(
    driver,
    `const body = { items: [{ id: arguments[0], quantity: arguments[1] }] };
     if (arguments[2]) body.items[0].properties = arguments[2];
     const r = await fetch('/cart/add.js', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
       body: JSON.stringify(body),
     });
     return { status: r.status, ok: r.ok };`,
    variantId,
    quantity,
    properties ?? null,
  );
}

// Change a line (by key) to an absolute quantity.
export async function changeLine(driver: WebDriver, key: string, quantity: number): Promise<void> {
  await evalAsync<void>(
    driver,
    `await fetch('/cart/change.js', {
       method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
       body: JSON.stringify({ id: arguments[0], quantity: arguments[1] }),
     });`,
    key,
    quantity,
  );
}

export async function fetchConfig(driver: WebDriver): Promise<CampaignConfig> {
  return evalAsync<CampaignConfig>(
    driver,
    `const c = (window.Shopify && window.Shopify.currency) || {};
     const cart = await (await fetch('/cart.js')).json();
     const params = new URLSearchParams({ currency: cart.currency, country: (window.Shopify && Shopify.country) || 'CA' });
     if (c.rate != null) params.set('rate', String(c.rate));
     const r = await fetch('/apps/free-gift/config?' + params.toString(), { headers: { Accept: 'application/json' } });
     return await r.json();`,
  );
}

// POST /validate for the CURRENT live cart (server-authoritative). isGift is derived server-side; we
// forward each line's app-added marker (the _fge_gift property) as the widget does. Choices/decline
// are supplied by the caller (default: none/declined false).
export async function fetchValidate(
  driver: WebDriver,
  opts: { choices?: Record<string, string>; declined?: boolean } = {},
): Promise<ValidateResult> {
  return evalAsync<ValidateResult>(
    driver,
    `const c = (window.Shopify && window.Shopify.currency) || {};
     const cart = await (await fetch('/cart.js')).json();
     const toGid = (id) => 'gid://shopify/ProductVariant/' + id;
     const req = {
       cart: cart.items.map((it) => ({
         variantId: toGid(it.variant_id),
         quantity: it.quantity,
         appAdded: !!(it.properties && it.properties['_fge_gift'] != null),
         hasDiscountAllocation: (it.discounts || []).some((d) => (d.amount || 0) > 0),
       })),
       choices: arguments[0] || {},
       declined: !!arguments[1],
       presentmentCurrency: cart.currency,
       countryCode: (window.Shopify && Shopify.country) || 'CA',
     };
     if (c.rate != null) req.presentmentRate = String(c.rate);
     const r = await fetch('/apps/free-gift/validate', {
       method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
       body: JSON.stringify(req),
     });
     return await r.json();`,
    opts.choices ?? {},
    opts.declined ?? false,
  );
}

export { numId };
