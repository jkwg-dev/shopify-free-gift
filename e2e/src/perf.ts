// Perf diagnostic: measure the network waterfall of a CHOOSER interaction (OR reselection — the
// "choose a different gift / variant" flow the shopper reports as 7–8s). It builds to tier 1, then
// instruments window.fetch IN THE PAGE and clicks the alternate gift; every request the reconcile
// issues (/validate, /cart.js, cart/change|add|update.js, ?sections=) is timestamped relative to the
// click. Prints a per-request waterfall + a grouped breakdown so the dominant cost is unambiguous.
//
// Measures BOTH surfaces (FGE_SURFACE=page|drawer|both, default both): the /cart PAGE and the header
// cart DRAWER — the drawer re-renders two cart apps + different sections, so its cost can differ.
//
// Run: FGE_LIVE=1 FGE_HEADLESS=0 tsx src/perf.ts   (needs live-store network + Chrome)
import { buildDriver, dumpConsole, evalAsync, gotoPreview, sleep, waitFor } from './browser.js';
import { buildSubtotal } from './catalog.js';
import { clearCart, fetchConfig } from './proxy.js';
import {
  allGiftProductIds,
  alternateOrTarget,
  tierByPosition,
  type ActiveConfig,
} from './helpers.js';
import type { OrReselect } from './helpers.js';
import {
  chooseOrOptionById,
  chooseVariantChip,
  giftLines,
  openDrawer,
  readWidget,
} from './widget.js';
import type { WebDriver } from 'selenium-webdriver';

type PerfRec = { url: string; method: string; start: number; dur: number; status?: number };
type Surface = 'page' | 'drawer';

// Install the in-page fetch instrument and mark t0 = now (the click follows immediately after).
async function armInstrument(driver: WebDriver): Promise<void> {
  await driver.executeScript(`
    window.__fgePerf = [];
    window.__fgeT0 = performance.now();
    if (!window.__fgeOrigFetch) window.__fgeOrigFetch = window.fetch;
    window.fetch = function() {
      const args = arguments;
      const a0 = args[0];
      const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0);
      const method = (args[1] && args[1].method) || (a0 && a0.method) || 'GET';
      const start = performance.now();
      const rec = { url: url, method: method, start: start - window.__fgeT0, dur: -1 };
      window.__fgePerf.push(rec);
      return window.__fgeOrigFetch.apply(this, args).then(
        function(r){ rec.dur = performance.now() - start; rec.status = r.status; return r; },
        function(e){ rec.dur = performance.now() - start; rec.status = -1; throw e; }
      );
    };
  `);
}

async function readInstrument(driver: WebDriver): Promise<PerfRec[]> {
  return evalAsync<PerfRec[]>(driver, `return (window.__fgePerf || []).slice();`);
}

// Time from t0 (click) until the widget stops being pending AND the chosen variant is the gift line.
async function waitConvergedAfterClick(
  driver: WebDriver,
  expectVariantId: string,
  surface: Surface,
): Promise<number> {
  const t0 = Date.now();
  await waitFor(
    async () => {
      const w = await readWidget(driver, surface);
      if (w.pending) return false;
      const gifts = await giftLines(driver);
      return gifts.length === 1 && gifts[0]!.variantId === expectVariantId;
    },
    { timeoutMs: 30_000, intervalMs: 250, label: `${surface}: reselection converged` },
  );
  return Date.now() - t0;
}

function classify(url: string): string {
  if (url.includes('/validate')) return 'VALIDATE (server)';
  if (url.includes('/config')) return 'config';
  if (url.includes('sections=')) return 'sections (theme render)';
  if (url.includes('cart/add')) return 'cart/add.js';
  if (url.includes('cart/change')) return 'cart/change.js';
  if (url.includes('cart/update')) return 'cart/update.js';
  if (url.includes('cart/clear')) return 'cart/clear.js';
  if (url.includes('/cart.js') || /\/cart(\?|$)/.test(url)) return 'cart.js (read)';
  return 'other';
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url, 'https://x');
    return u.pathname + (u.search ? u.search.slice(0, 40) : '');
  } catch {
    return url.slice(0, 60);
  }
}

function report(label: string, recs: PerfRec[], wallMs: number): void {
  const relevant = recs.filter((r) => classify(r.url) !== 'other');
  relevant.sort((a, b) => a.start - b.start);
  console.log(`\n================ ${label} ================`);
  console.log(`wall time click → converged: ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`requests during window: ${relevant.length}`);
  console.log('\n  start(ms)  dur(ms)  status  request');
  console.log('  ---------  -------  ------  -----------------------------------');
  for (const r of relevant) {
    console.log(
      `  ${String(Math.round(r.start)).padStart(9)}  ${String(Math.round(r.dur)).padStart(7)}  ${String(r.status ?? '').padStart(6)}  ${classify(r.url)}  ${shortUrl(r.url)}`,
    );
  }
  const byKind = new Map<string, { n: number; total: number }>();
  for (const r of relevant) {
    const k = classify(r.url);
    const cur = byKind.get(k) ?? { n: 0, total: 0 };
    cur.n += 1;
    cur.total += Math.max(0, r.dur);
    byKind.set(k, cur);
  }
  console.log('\n  grouped by kind (count × summed duration):');
  [...byKind.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([k, v]) => {
      console.log(
        `    ${k.padEnd(26)} ${String(v.n).padStart(2)} req   ${(v.total / 1000).toFixed(2)}s total`,
      );
    });
  const lastEnd = relevant.reduce((m, r) => Math.max(m, r.start + r.dur), 0);
  console.log(`\n  last request finished at: ${(lastEnd / 1000).toFixed(2)}s after click`);
}

async function selectAlt(driver: WebDriver, alt: OrReselect, surface: Surface): Promise<boolean> {
  if (alt.radioOptionId !== undefined)
    return chooseOrOptionById(driver, alt.radioOptionId, surface);
  if (alt.chipVariantLabel !== undefined)
    return chooseVariantChip(driver, alt.chipVariantLabel, surface);
  return false;
}

// Land on the surface with a settled tier-1 gift: the /cart PAGE, or the header DRAWER opened from a
// non-cart page (on /cart the cart icon just reloads the page, so the drawer is opened from home).
async function settleAtSurface(driver: WebDriver, surface: Surface): Promise<void> {
  if (surface === 'drawer') {
    await gotoPreview(driver, '/');
    if (!(await openDrawer(driver))) throw new Error('could not open the cart drawer');
  } else {
    await gotoPreview(driver, '/cart');
  }
  await waitFor(
    async () => {
      const w = await readWidget(driver, surface);
      // Require the chooser CARDS to be painted (not just present + gift line) so the alternate
      // radio/chip actually exists before we click it — otherwise the click races the first render.
      return w.present && !w.pending && w.cards.length > 0 && (await giftLines(driver)).length >= 1;
    },
    { timeoutMs: 30_000, intervalMs: 500, label: `${surface}: initial gift + chooser settled` },
  );
  await sleep(1500); // paint-stability margin (mirrors the pre-instrument settle the old harness used)
}

async function measureSurface(
  driver: WebDriver,
  surface: Surface,
  alt: OrReselect,
  back: OrReselect | null,
): Promise<void> {
  console.log(`\n########## SURFACE: ${surface.toUpperCase()} ##########`);
  await settleAtSurface(driver, surface);

  await armInstrument(driver);
  let selected = await selectAlt(driver, alt, surface);
  if (!selected) {
    // The control may not have painted yet — settle a moment, re-arm (reset t0) and retry once.
    await sleep(1500);
    await armInstrument(driver);
    selected = await selectAlt(driver, alt, surface);
  }
  if (!selected) throw new Error(`could not select the alternate option in the ${surface}`);
  const wall1 = await waitConvergedAfterClick(driver, alt.expectVariantId, surface);
  report(`${surface} · SAMPLE 1: default → alternate`, await readInstrument(driver), wall1);

  if (back !== null && back.expectVariantId !== alt.expectVariantId) {
    await sleep(3000);
    await armInstrument(driver);
    if (await selectAlt(driver, back, surface)) {
      const wall2 = await waitConvergedAfterClick(driver, back.expectVariantId, surface);
      report(`${surface} · SAMPLE 2: alternate → default`, await readInstrument(driver), wall2);
    }
  }
}

async function main(): Promise<void> {
  const surfaceEnv = (process.env['FGE_SURFACE'] ?? 'both').toLowerCase();
  const surfaces: Surface[] =
    surfaceEnv === 'page' ? ['page'] : surfaceEnv === 'drawer' ? ['drawer'] : ['page', 'drawer'];

  const driver = await buildDriver();
  try {
    await gotoPreview(driver, '/cart');
    await driver.executeScript(`try { localStorage.setItem('fge_debug','1'); } catch(e){}`);
    await gotoPreview(driver, '/cart');

    const config = await fetchConfig(driver);
    if (config.status !== 'active') throw new Error('config inactive');
    const active = config as ActiveConfig;
    const t1 = tierByPosition(active, 1);
    const alt = alternateOrTarget(t1);
    if (alt === null) throw new Error('tier 1 is not an OR tier with ≥2 available options');
    const firstOpt = t1.gift.kind === 'OR' ? t1.gift.options.find((o) => o.available)! : null;
    const back: OrReselect | null =
      firstOpt !== null
        ? { radioOptionId: firstOpt.optionId, expectVariantId: firstOpt.variantId }
        : null;

    console.log('building to tier 1…');
    await clearCart(driver);
    await sleep(1500);
    const built = await buildSubtotal(driver, t1.threshold.amountMinor, allGiftProductIds(active), {
      ceiling: tierByPosition(active, 2)?.threshold.amountMinor,
    });
    console.log('server subtotal:', built.subtotalMinor / 100);

    for (const surface of surfaces) {
      await measureSurface(driver, surface, alt, back);
    }

    console.log('\n--- [FGE] console tail (reconcile passes) ---');
    for (const l of await dumpConsole(driver, 200)) {
      if (/\[FGE\]|reconcile outcome|pass \d/.test(l)) console.log(l.slice(0, 300));
    }
    console.log('\nPERF DONE');
  } catch (err) {
    console.error('PERF FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
