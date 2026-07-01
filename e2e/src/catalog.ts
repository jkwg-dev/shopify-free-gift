// Catalog discovery + subtotal builder. Reaching a tier on a LIVE store means building a real cart to
// a target qualifying subtotal. We NEVER trust products.json prices for the math (they're base-currency
// and ignore promos): every amount is read back from /validate (server-authoritative, presentment
// currency, gift lines + discounted lines already excluded). products.json is used ONLY to enumerate
// buyable variants and order them by price.
//
// Robustness: quantities are spread across several mid-priced SKUs (per-SKU cap) so no single SKU's
// stock is exhausted; a cheap "fine unit" makes the final approach land within a few dollars of the
// target. Gift-card products and the campaign's own gift products are excluded.
import { WebDriver } from 'selenium-webdriver';
import { evalAsync, sleep } from './browser.js';
import { addToCart, changeLine, fetchValidate, getCart } from './proxy.js';

export type Candidate = { id: number; price: number; title: string; product: string };

let cache: Candidate[] | null = null;

export async function loadCatalog(
  driver: WebDriver,
  giftProductIds: ReadonlySet<string>,
): Promise<Candidate[]> {
  if (cache !== null) return cache;
  const raw = await evalAsync<
    { id: number; price: number; title: string; product: string; productId: string; type: string }[]
  >(
    driver,
    `const out = [];
     for (let page = 1; page <= 2; page++) {
       const r = await fetch('/products.json?limit=250&page=' + page, { headers: { Accept: 'application/json' } });
       if (!r.ok) break;
       const d = await r.json();
       const prods = d.products || [];
       if (prods.length === 0) break;
       for (const p of prods) {
         for (const v of (p.variants || [])) {
           if (!v.available) continue;
           const price = Number(v.price);
           if (!(price > 0)) continue;
           out.push({
             id: v.id, price, title: (v.title || ''), product: (p.title || ''),
             productId: 'gid://shopify/Product/' + p.id, type: (p.product_type || ''),
           });
         }
       }
       if (prods.length < 250) break;
     }
     return out;`,
  );

  const isGiftCard = (c: { title: string; product: string; type: string }): boolean =>
    /gift\s*card/i.test(c.product) || /gift\s*card/i.test(c.title) || /gift\s*card/i.test(c.type);

  cache = raw
    .filter((c) => !isGiftCard(c) && !giftProductIds.has(c.productId))
    .map((c) => ({ id: c.id, price: c.price, title: c.title, product: c.product }))
    .sort((a, b) => a.price - b.price);
  return cache;
}

async function subtotalMinor(driver: WebDriver): Promise<number> {
  const r = await fetchValidate(driver);
  if (r.status === 'gift') return r.subtotal.amountMinor;
  if (r.status === 'no-gift' && r.subtotal) return r.subtotal.amountMinor;
  return 0;
}

// Cart writes race the widget's own reconcile writes (the AJAX cart serializes writes → occasional
// 422). Retry a few times.
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

async function addOne(driver: WebDriver, id: number): Promise<boolean> {
  const res = await withRetry(() => addToCart(driver, id, 1));
  return res.ok;
}

async function setQty(driver: WebDriver, id: number, qty: number): Promise<void> {
  await withRetry(() => changeLine(driver, String(id), qty));
}

// Qty currently in the cart for a buy variant (0 if absent). Used to detect a stock cap (achieved < set).
async function cartQty(driver: WebDriver, id: number): Promise<number> {
  const cart = await getCart(driver);
  return cart.items
    .filter((it) => it.variant_id === id && !(it.properties && it.properties['_fge_gift'] != null))
    .reduce((n, it) => n + it.quantity, 0);
}

export type BuildResult = { subtotalMinor: number; fineVariantId: number | null };

// Build the cart's qualifying subtotal to `target` minor units. `below`: land as close as possible but
// strictly under `target` (for boundary / downgrade tests). Otherwise land >= `target` with small
// overshoot. Returns the achieved subtotal + the cheap "fine" variant used (so a boundary test can add
// one more of it to cross, or the caller can step it down).
export async function buildSubtotal(
  driver: WebDriver,
  target: number,
  giftProductIds: ReadonlySet<string>,
  opts: { below?: boolean } = {},
): Promise<BuildResult> {
  const below = opts.below ?? false;
  const cands = await loadCatalog(driver, giftProductIds);
  if (cands.length === 0) throw new Error('no buy candidates discovered');

  // Fine unit: cheapest candidate that actually contributes (unit > 0). Bulk fillers: a spread of
  // mid-priced SKUs so we don't exhaust one SKU's stock.
  const fine = cands[0]!;
  const perSkuCap = 10;

  let S = await subtotalMinor(driver);
  const unitCache = new Map<number, number>();
  const measure = async (id: number): Promise<number> => {
    if (unitCache.has(id)) return unitCache.get(id)!;
    const before = S;
    if (!(await addOne(driver, id))) {
      unitCache.set(id, 0);
      return 0;
    }
    const after = await subtotalMinor(driver);
    const unit = Math.max(0, after - before);
    S = after;
    unitCache.set(id, unit);
    return unit;
  };

  // --- coarse phase: fill toward (target - headroom) using bulk SKUs, spreading across variants. ---
  const headroom = below ? Math.max(fine.price * 100 * 3, 5000) : 3000;
  const bulk = cands.filter(
    (c) => c.price * 100 >= 4000 && c.price * 100 <= Math.max(4000, target / 3),
  );
  const bulkPool = bulk.length > 0 ? bulk : cands.filter((c) => c.price * 100 <= target);
  let bi = 0;
  let guard = 0;
  while (S < target - headroom && guard++ < 200) {
    const cand = bulkPool[bi % bulkPool.length];
    if (cand === undefined) break;
    bi++;
    const unit = await measure(cand.id); // adds 1 as part of measuring
    if (unit <= 0) continue;
    const need = target - headroom - S;
    if (need <= 0) break;
    const addMore = Math.min(perSkuCap - 1, Math.max(0, Math.floor(need / unit)));
    if (addMore > 0) {
      const targetQty = (await cartQty(driver, cand.id)) + addMore;
      await setQty(driver, cand.id, targetQty);
      const achieved = await cartQty(driver, cand.id);
      S = await subtotalMinor(driver);
      if (achieved < targetQty) {
        // stock-capped this SKU; drop it from the rotation by removing from pool
        bulkPool.splice(bulkPool.indexOf(cand), 1);
        if (bulkPool.length === 0) break;
        bi = 0;
      }
    }
    if (bi > bulkPool.length * (perSkuCap + 2)) break; // safety: pool exhausted
  }

  // --- fine phase: approach target with the cheap unit (+1 at a time). ---
  const fineUnit = (await measure(fine.id)) || fine.price * 100;
  guard = 0;
  while (S < target && guard++ < 400) {
    if (!(await addOne(driver, fine.id))) break;
    S = await subtotalMinor(driver);
  }

  if (below) {
    // Step the fine unit down until strictly below target.
    guard = 0;
    while (S >= target && guard++ < 400) {
      const q = await cartQty(driver, fine.id);
      if (q <= 0) break;
      await setQty(driver, fine.id, q - 1);
      S = await subtotalMinor(driver);
    }
  }

  void fineUnit;
  return { subtotalMinor: S, fineVariantId: fine.id };
}
