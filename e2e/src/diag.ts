// Diagnostic: reproduce the CART-PAGE in-page reconcile bug the shopper hits (drawer is fine).
// Flow, all on /cart with NO reload after the first build:
//   1) build to tier 1 (gift present, $0) and reload once for a clean DOM
//   2) IN-PAGE: drive the NATIVE qty stepper (set value + dispatch 'change', exactly what Dawn
//      listens to) to drop the qualifying subtotal BELOW tier 1
//   3) report what is VISIBLE in the /cart page's own <cart-items> (NOT the header drawer): every
//      line's variant, qty, price text, and whether it's display:none — plus cart.js gift lines and
//      the widget's [FGE] console logs.
// The user's bug: after the decrease the previous gift line stays VISIBLE and shows a PRICE (its $0
// code was cleared but the DOM node was never removed/hidden on the page surface).
import { buildDriver, dumpConsole, evalAsync, gotoPreview, sleep } from './browser.js';
import { buildSubtotal } from './catalog.js';
import { clearCart, fetchConfig, fetchValidate, getCart } from './proxy.js';
import { allGiftProductIds } from './helpers.js';

type VisibleLine = {
  variantId: number | null;
  title: string;
  qty: string;
  priceText: string;
  hidden: boolean;
  isGiftProp: boolean;
};

// Read the /cart PAGE cart-items host (id starts with template-- / equals main section), never the
// header cart-drawer-items. Report each rendered .cart-item row's key facts + visibility.
const READ_PAGE_LINES = `
  const hosts = Array.prototype.filter.call(
    document.querySelectorAll('cart-items, #main-cart-items'),
    (el) => !el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification'));
  const host = hosts[0] || null;
  if (!host) return { hostFound: false, lines: [] };
  const rows = host.querySelectorAll('.cart-item, [id^="CartItem-"], cart-item, .cart__row');
  const lines = Array.prototype.map.call(rows, (row) => {
    const link = row.querySelector('a[href*="variant="]');
    const m = link ? link.href.match(/variant=(\\d+)/) : null;
    const priceEl = row.querySelector('.cart-item__total-price, .cart-item__actions--price, .cart-item__price');
    const qtyInput = row.querySelector('.quantity__input, input[name="updates[]"]');
    const cs = getComputedStyle(row);
    return {
      variantId: m ? Number(m[1]) : null,
      title: (row.querySelector('.cart-item__name, .cart-item__details a, a')||{}).textContent ? (row.querySelector('.cart-item__name, .cart-item__details a, a').textContent||'').trim().replace(/\\s+/g,' ').slice(0,40) : '',
      qty: qtyInput ? qtyInput.value : '',
      priceText: priceEl ? (priceEl.textContent||'').trim().replace(/\\s+/g,' ') : '',
      hidden: cs.display === 'none' || row.getAttribute('data-fge-gift-hidden') !== null,
      isGiftProp: /_fge_gift/.test(row.innerHTML),
    };
  });
  return { hostFound: true, hostId: host.id || host.tagName.toLowerCase(), lines };
`;

async function readPageLines(
  driver: import('selenium-webdriver').WebDriver,
): Promise<{ hostFound: boolean; hostId?: string; lines: VisibleLine[] }> {
  return evalAsync(driver, `return (function(){ ${READ_PAGE_LINES} })();`);
}

// Click the native +/- stepper button on the PAGE buy line for `variantId` (real Dawn interaction:
// Dawn's cart-items handles the click → cart/change.js → section re-render; our fetch patch also
// schedules a reconcile). dir: 'inc' | 'dec'. Returns whether a button was found + clicked.
async function clickStep(
  driver: import('selenium-webdriver').WebDriver,
  variantId: number,
  dir: 'inc' | 'dec',
): Promise<boolean> {
  return evalAsync<boolean>(
    driver,
    `const vid = arguments[0], dir = arguments[1];
     const hosts = Array.prototype.filter.call(
       document.querySelectorAll('cart-items, #main-cart-items'),
       (el) => !el.closest('cart-drawer, #CartDrawer, .cart-drawer, .drawer--cart, cart-notification'));
     const host = hosts[0]; if (!host) return false;
     const rows = host.querySelectorAll('.cart-item, [id^="CartItem-"], cart-item, .cart__row');
     for (const row of rows) {
       if (!row.querySelector('a[href*="variant=' + vid + '"]')) continue;
       const sel = dir === 'inc'
         ? '.quantity__button[name="increment"], .quantity__button[name="plus"], button[name="plus"]'
         : '.quantity__button[name="decrement"], .quantity__button[name="minus"], button[name="minus"]';
       const btn = row.querySelector(sel);
       if (!btn) return false;
       btn.click();
       return true;
     }
     return false;`,
    variantId,
    dir,
  );
}

// Server qualifying subtotal (declined:true → no OR choice needed), in minor units.
async function serverSubtotal(driver: import('selenium-webdriver').WebDriver): Promise<number> {
  const v = (await fetchValidate(driver, { declined: true })) as {
    subtotal?: { amountMinor?: number };
  };
  return v.subtotal?.amountMinor ?? 0;
}

async function snapshot(
  driver: import('selenium-webdriver').WebDriver,
  label: string,
): Promise<void> {
  const cart = await getCart(driver);
  const gifts = cart.items.filter((i) => i.properties && i.properties['_fge_gift'] != null);
  const sub = await serverSubtotal(driver);
  const page = await readPageLines(driver);
  const stragglers = page.lines.filter(
    (l) => !l.hidden && (l.isGiftProp || /\$0\.00/.test(l.priceText)),
  );
  console.log(`\n=== ${label} ===`);
  console.log(`server qualifying subtotal: ${sub / 100}`);
  console.log(
    'cart.js gifts:',
    JSON.stringify(
      gifts.map((g) => ({ v: g.variant_id, q: g.quantity, price: g.final_line_price })),
    ),
  );
  console.log('visible page lines:', JSON.stringify(page.lines, null, 1));
  if (stragglers.length > 0) {
    console.log(`❗ visible gift/$0 straggler rows: ${JSON.stringify(stragglers)}`);
  }
}

// Largest non-gift line's variant id (the full-price qualifying anchor we drive in-page).
async function largestBuyVariant(
  driver: import('selenium-webdriver').WebDriver,
): Promise<number | null> {
  const cart = await getCart(driver);
  const buy = cart.items
    .filter((i) => !(i.properties && i.properties['_fge_gift'] != null))
    .sort((a, b) => b.final_line_price - a.final_line_price)[0];
  return buy ? buy.variant_id : null;
}

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    await gotoPreview(driver, '/cart');
    // Enable the widget's gated [FGE] reconcile logging for this session, then reload so init() runs on.
    await driver.executeScript(`try { localStorage.setItem('fge_debug','1'); } catch(e){}`);
    await gotoPreview(driver, '/cart');
    const config = await fetchConfig(driver);
    if (config.status !== 'active') throw new Error('config inactive');
    const giftProductIds = allGiftProductIds(config);
    const t1 = config.tiers.find((t) => t.position === 1)!;
    const t2 = config.tiers.find((t) => t.position === 2);
    const threshold = t1.threshold.amountMinor;

    await clearCart(driver);
    await sleep(1500);

    // Build to tier 1 with SERVER-VETTED full-price qualifying products (buildSubtotal removes any
    // discounted / non-collection SKU). Reload once for a clean DOM.
    console.log('building to tier 1 with full-price qualifying products…');
    const built = await buildSubtotal(driver, threshold, giftProductIds, {
      ceiling: t2?.threshold.amountMinor,
    });
    console.log(
      'server subtotal after build:',
      built.subtotalMinor / 100,
      'anchor:',
      built.anchorVariantId,
    );
    await gotoPreview(driver, '/cart');
    await sleep(7000);
    await snapshot(driver, 'AFTER build (expect exactly ONE tier-1 gift, $0, visible)');

    const anchor = built.anchorVariantId ?? (await largestBuyVariant(driver));
    if (anchor === null) throw new Error('no anchor buy line to drive');

    // IN-PAGE downgrade: decrement the full-price anchor with the native button until qualifying < tier 1.
    for (let i = 0; i < 12; i++) {
      const sub = await serverSubtotal(driver);
      if (sub < threshold) break;
      console.log(
        `\n>> native DECREMENT anchor ${anchor} (qualifying ${sub / 100} >= ${threshold / 100})`,
      );
      const ok = await clickStep(driver, anchor, 'dec');
      console.log('  decrement clicked:', ok);
      if (!ok) break;
      await sleep(8000);
    }
    await snapshot(
      driver,
      'AFTER in-page DECREMENT below tier 1 (expect NO gift, none visible/priced)',
    );

    // IN-PAGE add back: increment the full-price anchor until qualifying >= tier 1 again.
    for (let i = 0; i < 12; i++) {
      const sub = await serverSubtotal(driver);
      if (sub >= threshold) break;
      console.log(
        `\n>> native INCREMENT anchor ${anchor} (qualifying ${sub / 100} < ${threshold / 100})`,
      );
      const ok = await clickStep(driver, anchor, 'inc');
      console.log('  increment clicked:', ok);
      if (!ok) break;
      await sleep(8000);
    }
    await snapshot(
      driver,
      'AFTER in-page INCREMENT back above tier 1 (expect ONE gift, $0, visible)',
    );

    console.log('\n--- FGE console tail ---');
    for (const l of await dumpConsole(driver, 120)) {
      if (/\[FGE\]|free-gift|DRAWERFIX/.test(l)) console.log(l.slice(0, 400));
    }
    console.log('\nDIAG DONE');
  } catch (err) {
    console.error('DIAG FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
