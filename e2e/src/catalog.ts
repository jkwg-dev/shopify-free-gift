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
import { addToCart, changeLineStatus, fetchValidate, getCart } from './proxy.js';

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

// The active market's FX rate (presentment = base × rate), read from the storefront. 1 in the base
// market. Used to convert the presentment-currency tier band into the base currency the candidate
// prices are quoted in, so the anchor cap is comparable across markets.
async function presentmentRate(driver: WebDriver): Promise<number> {
  const r = await evalAsync<number>(
    driver,
    `return (window.Shopify && window.Shopify.currency && Number(window.Shopify.currency.rate)) || 1;`,
  );
  return Number.isFinite(r) && r > 0 ? r : 1;
}

// Local /cart.js sum of non-gift line finals. Cheap (no App Proxy). For a cart that contains ONLY
// qualifying-collection products this EQUALS the server's qualifying subtotal (ground-truthed by
// probe-qualify), so it is the fast progress signal while GROWING a SKU already vetted as qualifying.
async function localSubtotal(driver: WebDriver): Promise<number> {
  const cart = await getCart(driver);
  return cart.items
    .filter((it) => !(it.properties && it.properties['_fge_gift'] != null))
    .reduce((n, it) => n + it.final_line_price, 0);
}

// Qualifying subtotal as the SERVER computes it, via /validate with declined:true (no gift resolved,
// so no OR choice is needed even when a lower tier is crossed — the response still carries `subtotal`).
// /validate only counts lines whose product is IN the qualifying collection and that carry no discount
// allocation (CLAUDE.md model C); a local /cart.js sum counts every paid line, so a cart of
// non-qualifying products the server scores as $0 (e.g. this store's expensive clubs/carts). Used
// SPARINGLY: once to vet each newly-introduced SKU, and once at the end to confirm — never per unit.
async function serverSubtotal(driver: WebDriver): Promise<number> {
  const v = (await fetchValidate(driver, { declined: true })) as {
    subtotal?: { amountMinor?: number };
  };
  return v.subtotal?.amountMinor ?? 0;
}

// Remove a buy line entirely (quantity 0). Used to drop an anchor that turned out NOT to count toward
// the qualifying subtotal (not in the collection / discounted) so the cart stays clean.
async function removeLine(driver: WebDriver, id: number): Promise<void> {
  await changeLineStatus(driver, String(id), 0);
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

// Raise a line toward `desired`, but respect the SKU's live stock: a 422 means the store refused that
// quantity, so we geometrically back off until it sticks (or we hit 1). Returns the achieved quantity.
// This is what makes high-subtotal tiers ($1000/$1500) buildable without a single SKU's stock 422-ing
// the whole run — the caller tops up the shortfall with additional SKUs.
async function raiseLineToCap(driver: WebDriver, id: number, desired: number): Promise<number> {
  let q = Math.max(1, desired);
  for (let step = 0; step < 24 && q >= 1; step++) {
    const s = await changeLineStatus(driver, String(id), q);
    if (s >= 200 && s < 300) return cartQty(driver, id);
    if (s !== 422) break; // a non-stock error: stop and report whatever is in the cart
    q -= Math.max(1, Math.ceil(q * 0.25));
  }
  return cartQty(driver, id);
}

// Qty currently in the cart for a buy variant (0 if absent). Used to detect a stock cap (achieved < set).
async function cartQty(driver: WebDriver, id: number): Promise<number> {
  const cart = await getCart(driver);
  return cart.items
    .filter((it) => it.variant_id === id && !(it.properties && it.properties['_fge_gift'] != null))
    .reduce((n, it) => n + it.quantity, 0);
}

export type BuildResult = { subtotalMinor: number; anchorVariantId: number | null };

// Qualifying membership on this store is by COLLECTION (brand/type), NOT price — qualifying products span
// $1.99 to ~$1300 while many mid/expensive SKUs (PXG apparel, shafts, the $50k club set) are excluded
// (ground-truthed by probe-price-scan). So anchors are chosen priciest-first (fewest units → fewest
// requests) among products whose price fits the tier BAND, and any non-member is skipped via the
// /validate delta. The per-build cap keeps the landing inside [target, ceiling).

// Introduce ONE qualifying SKU: scan the pool priciest-first, add a unit, and VET it with a SINGLE
// /validate — did the server subtotal rise above what we already have? A pick that does not is not a
// collection member (or is discounted) → removed. Returns the SKU + its measured presentment unit price
// + the new server subtotal, or null. One validate per candidate examined; the SKU is then GROWN purely
// against the local /cart.js sum (which equals the server subtotal for a qualifying-only cart), so we do
// NOT pay a validate per quantity step (that was the request-storm that tripped the volume limiter).
async function introduceQualifying(
  driver: WebDriver,
  pool: Candidate[],
  tried: Set<number>,
  serverKnown: number,
  attempts: number,
  fromCheap = false,
): Promise<{ cand: Candidate; unit: number; serverKnown: number } | null> {
  for (let i = 0; i < attempts; i++) {
    const remaining = pool.filter((c) => !tried.has(c.id));
    if (remaining.length === 0) return null;
    // Priciest-first (fewest units) for a tier build; cheapest-first for `below`, where a near-target
    // anchor can't land under target and the priciest band is a big EXCLUDED cluster on this store.
    const cand = fromCheap ? remaining[0]! : remaining[remaining.length - 1]!;
    tried.add(cand.id);
    if (!(await addOne(driver, cand.id))) continue;
    const server = await serverSubtotal(driver);
    if (server > serverKnown) return { cand, unit: server - serverKnown, serverKnown: server };
    await removeLine(driver, cand.id); // added but did not count → not qualifying; drop it
  }
  return null;
}

// Build the cart's SERVER qualifying subtotal to `target` minor units with as FEW live requests as
// possible: introduce a qualifying anchor (server-vetted), then reach the target by growing it against
// the local sum in a bounded loop, spreading across fresh qualifying SKUs when a SKU's stock caps out.
// `below`: land strictly under `target`; otherwise land >= `target`. One final /validate confirms.
export async function buildSubtotal(
  driver: WebDriver,
  target: number,
  giftProductIds: ReadonlySet<string>,
  opts: { below?: boolean; ceiling?: number } = {},
): Promise<BuildResult> {
  const below = opts.below ?? false;
  const cands = await loadCatalog(driver, giftProductIds);
  if (cands.length === 0) throw new Error('no buy candidates discovered');
  // Anchor price cap = the tier BAND width so a whole-unit overshoot cannot spill past `ceiling` into the
  // next tier (landing stays in [target, ceiling)). Top tier (no ceiling) → cap at `target` (overshoot is
  // then harmless). `target`/`ceiling` are in the PRESENTMENT currency, but candidate prices come from
  // products.json in the store's BASE currency — so convert the cap by the market rate (presentment =
  // base × rate). Without this, a non-base market wrongly excludes base-priced anchors (e.g. a $499 CAD
  // putter ≈ $365 USD, right at tier-1-USD) and the scan burns out on the excluded mid-priced cluster.
  const bandMinor = opts.ceiling !== undefined ? opts.ceiling - target : target;
  const rate = await presentmentRate(driver);
  const capBaseDollars = Math.max(1, bandMinor) / 100 / rate;
  const pool = cands.filter((c) => c.price <= capBaseDollars);
  const anchorPool = pool.length > 0 ? pool : cands;

  const tried = new Set<number>();
  const serverStart = await serverSubtotal(driver);
  const first = await introduceQualifying(driver, anchorPool, tried, serverStart, 24, below);
  if (first === null) throw new Error('could not find a qualifying anchor SKU');
  let cursor = first.cand;
  let cursorUnit = first.unit;
  const anchorVariantId = first.cand.id;
  // From here progress is tracked with the local sum (== server for a qualifying-only cart).
  let S = await localSubtotal(driver);

  // One-shot quantity: ceil to reach, floor to stay below. (S reflects the 1 anchor unit already in.)
  const rawExtra = below
    ? Math.floor((target - 1 - S) / cursorUnit)
    : Math.ceil((target - S) / cursorUnit);
  const qty = Math.max(1, 1 + Math.max(0, rawExtra));
  let achieved = await raiseLineToCap(driver, cursor.id, qty);
  S = await localSubtotal(driver);

  // Correction: for a tier build (>= target) keep growing the cursor SKU; when it's stock-capped, bring
  // in a fresh qualifying SKU and grow that instead. For `below`, trim down until strictly under target.
  let guard = 0;
  while (guard++ < 40) {
    if (below) {
      if (S < target) break;
      if (achieved <= 1) break;
      achieved = await raiseLineToCap(driver, cursor.id, achieved - 1);
      S = await localSubtotal(driver);
      continue;
    }
    if (S >= target) break;
    const want = achieved + Math.max(1, Math.ceil((target - S) / Math.max(1, cursorUnit)));
    const grown = await raiseLineToCap(driver, cursor.id, want);
    if (grown > achieved) {
      achieved = grown;
      S = await localSubtotal(driver);
      continue;
    }
    // Current SKU stock-capped → introduce a fresh qualifying SKU (S == server for this qualifying cart).
    const next = await introduceQualifying(driver, anchorPool, tried, S, 8, below);
    if (next === null) break;
    cursor = next.cand;
    cursorUnit = next.unit;
    achieved = await cartQty(driver, next.cand.id);
    S = await localSubtotal(driver);
  }

  // Confirm against the authoritative server subtotal (one validate) so the result reflects reality.
  const finalServer = await serverSubtotal(driver);
  return { subtotalMinor: finalServer, anchorVariantId };
}
