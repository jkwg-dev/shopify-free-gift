// In-browser Shopify + App Proxy helpers. Everything runs in the PAGE context (same origin) so the
// preview session cookie is present and Shopify signs the /apps/free-gift/* proxy calls exactly as it
// does for the real widget. /config + /validate auto-attach the LIVE market context (currency + FX
// rate from window.Shopify.currency) so multi-currency runs need no extra plumbing.
import { WebDriver } from 'selenium-webdriver';
import { evalAsync, sleep } from './browser.js';

export type Money = { readonly amountMinor: number; readonly currency: string };

// --- throttle + 429-aware retry -----------------------------------------------------------------
// The live store (Cloudflare + the App Proxy per-shop+buyer limiter) 429s aggressively under bursts.
// Every network-bearing helper goes through gate(): serialized + spaced at least MIN_GAP_MS apart, and
// retried with exponential backoff when the in-page fetch reports a 429 (or returns non-JSON, which is
// what a Cloudflare HTML error page looks like to fetch().json()).
// Pacing: with the stealth HEADFUL driver (real fingerprint + persistent profile) the store no longer
// bot-throttles us, so a small gap is enough to serialize writes and avoid cart-write contention. (The
// old 3s gap was a workaround for the automation-detection 429s, now fixed at the driver layer.)
const MIN_GAP_MS = Number(process.env['FGE_MIN_GAP_MS'] ?? 700);
// On a 429 the store BANS the IP for a window, and continuing to hit EXTENDS the ban — so we retry few
// times with a LONG quiet wait (let the window drain) instead of hammering with short backoff.
const MAX_RETRIES = Number(process.env['FGE_MAX_RETRIES'] ?? 3);
const RL_QUIET_MS = Number(process.env['FGE_RL_QUIET_MS'] ?? 60000);
const DEBUG = process.env['FGE_DEBUG'] === '1';
let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;
let reqSeq = 0;

async function gate<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = MIN_GAP_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return fn();
  };
  const next = chain.then(run, run);
  // keep the chain alive regardless of this call's success
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

class RateLimited extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean = true,
  ) {
    super(message);
  }
}

// Wrap an in-page fetch that returns { s: <httpStatus>, j: <parsedJson|null> }. Retry on 429 / null body
// (rate-limit HTML). `retryStatuses` lets a caller also retry a transient 422 (cart write contention).
async function jsonCall<T>(
  driver: WebDriver,
  body: string,
  args: unknown[],
  opts: { retryStatuses?: number[]; tag?: string } = {},
): Promise<{ s: number; j: T | null }> {
  const retry = new Set([429, ...(opts.retryStatuses ?? [])]);
  const tag = opts.tag ?? 'req';
  const id = ++reqSeq;
  let lastErr: unknown;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const res = await gate(() => evalAsync<{ s: number; j: T | null }>(driver, body, ...args));
      const rateLimited = res.s === 429 || (res.j === null && res.s >= 400);
      const transient = res.s >= 500; // Shopify 5xx (overload) — retry short, never treat as success
      if (rateLimited || transient || retry.has(res.s)) {
        throw new RateLimited(`http ${res.s}`, rateLimited);
      }
      if (DEBUG) process.stderr.write(`  [net #${id} ${tag}] ${res.s} ok\n`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i === MAX_RETRIES) break;
      // A rate-limit (429/HTML) needs a LONG quiet wait so the ban window drains; a plain transient
      // (e.g. a 422 cart-write contention) just needs a short retry.
      const isRl = e instanceof RateLimited && e.rateLimited;
      const wait = isRl ? RL_QUIET_MS : 2000;
      if (DEBUG)
        process.stderr.write(
          `  [net #${id} ${tag}] retry ${i}/${MAX_RETRIES} (${isRl ? `rate-limited, quiet ${wait / 1000}s` : String(e)})\n`,
        );
      await sleep(wait + Math.floor(Math.random() * 1000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

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
  const { j } = await jsonCall<Cart>(
    driver,
    `const r = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
     let j = null; try { j = await r.json(); } catch (e) {}
     return { s: r.status, j };`,
    [],
    { tag: 'cart' },
  );
  if (j === null) throw new Error('getCart: null cart');
  return j;
}

export async function clearCart(driver: WebDriver): Promise<void> {
  await jsonCall<{ ok: boolean }>(
    driver,
    `const r = await fetch('/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
     return { s: r.status, j: { ok: r.ok } };`,
    [],
    { tag: 'clear' },
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
  // 429 is retried; a 422 (unpublished/OOS gift, or invalid qty) is a MEANINGFUL result — return it.
  const { s } = await jsonCall<{ ok: boolean }>(
    driver,
    `const body = { items: [{ id: arguments[0], quantity: arguments[1] }] };
     if (arguments[2]) body.items[0].properties = arguments[2];
     const r = await fetch('/cart/add.js', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
       body: JSON.stringify(body),
     });
     let j = null; try { j = await r.json(); } catch (e) {}
     return { s: r.status, j: { ok: r.ok } };`,
    [variantId, quantity, properties ?? null],
    { tag: 'add' },
  );
  return { status: s, ok: s >= 200 && s < 300 };
}

// Change a line (by key) to an absolute quantity, returning the raw HTTP status. A 422 is MEANINGFUL
// here — it's Shopify refusing an over-stock quantity — so we do NOT retry it (that just wastes time and
// hides the cap); callers back off the quantity instead. 429 is still retried inside jsonCall.
export async function changeLineStatus(
  driver: WebDriver,
  key: string,
  quantity: number,
): Promise<number> {
  const { s } = await jsonCall<{ ok: boolean }>(
    driver,
    `const r = await fetch('/cart/change.js', {
       method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
       body: JSON.stringify({ id: arguments[0], quantity: arguments[1] }),
     });
     let j = null; try { j = await r.json(); } catch (e) {}
     return { s: r.status, j: { ok: r.ok } };`,
    [key, quantity],
    { tag: 'change' },
  );
  return s;
}

// Change a line to an absolute quantity, throwing if the store rejects it (non-2xx).
export async function changeLine(driver: WebDriver, key: string, quantity: number): Promise<void> {
  const s = await changeLineStatus(driver, key, quantity);
  if (s < 200 || s >= 300) throw new Error(`changeLine failed: http ${s}`);
}

export async function fetchConfig(driver: WebDriver): Promise<CampaignConfig> {
  const { j } = await jsonCall<CampaignConfig>(
    driver,
    `const c = (window.Shopify && window.Shopify.currency) || {};
     const cr = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
     let cart = null; try { cart = await cr.json(); } catch (e) {}
     if (!cart) return { s: cr.status || 429, j: null };
     const params = new URLSearchParams({ currency: cart.currency, country: (window.Shopify && Shopify.country) || 'CA' });
     if (c.rate != null) params.set('rate', String(c.rate));
     const r = await fetch('/apps/free-gift/config?' + params.toString(), { headers: { Accept: 'application/json' } });
     let j = null; try { j = await r.json(); } catch (e) {}
     return { s: r.status, j };`,
    [],
    { tag: 'config' },
  );
  if (j === null) throw new Error('fetchConfig: null');
  return j;
}

// POST /validate for the CURRENT live cart (server-authoritative). isGift is derived server-side; we
// forward each line's app-added marker (the _fge_gift property) as the widget does. Choices/decline
// are supplied by the caller (default: none/declined false).
export async function fetchValidate(
  driver: WebDriver,
  opts: { choices?: Record<string, string>; declined?: boolean } = {},
): Promise<ValidateResult> {
  const { j } = await jsonCall<ValidateResult>(
    driver,
    `const c = (window.Shopify && window.Shopify.currency) || {};
     const cr = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
     let cart = null; try { cart = await cr.json(); } catch (e) {}
     if (!cart) return { s: cr.status || 429, j: null };
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
     let j = null; try { j = await r.json(); } catch (e) {}
     return { s: r.status, j };`,
    [opts.choices ?? {}, opts.declined ?? false],
    { tag: 'validate' },
  );
  if (j === null) throw new Error('fetchValidate: null');
  return j;
}

export { numId };
