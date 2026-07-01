// Probe: which cart surface mounts the widget on THIS theme (page-context vs drawer-context), and does
// crossing tier1 render the chooser + free gift line. Determines the default assertion context.
import { buildDriver, dumpConsole, gotoPreview, sleep } from './browser.js';
import { buildSubtotal } from './catalog.js';
import { fetchConfig, fetchValidate } from './proxy.js';
import { allGiftProductIds } from './helpers.js';
import { giftLines, openDrawer, readWidget } from './widget.js';

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    await gotoPreview(driver, '/cart');
    const config = await fetchConfig(driver);
    if (config.status !== 'active') throw new Error('config inactive');
    const giftProductIds = allGiftProductIds(config);
    const t1 = config.tiers.find((t) => t.position === 1)!;

    console.log(
      'building cart to tier1 threshold',
      t1.threshold.amountMinor / 100,
      config.currency,
    );
    const r = await buildSubtotal(driver, t1.threshold.amountMinor, giftProductIds);
    console.log('achieved subtotal minor:', r.subtotalMinor);

    await gotoPreview(driver, '/cart');
    await sleep(4000);
    const v = await fetchValidate(driver);
    console.log('validate:', v.status, (v as { tierId?: string }).tierId ?? '');
    console.log('gift lines:', JSON.stringify(await giftLines(driver)));

    const page = await readWidget(driver, 'page');
    const drawer = await readWidget(driver, 'drawer');
    console.log(
      'PAGE widget:',
      JSON.stringify({
        present: page.present,
        headline: page.headline,
        title: page.chooserTitle,
        cards: page.cards.length,
        steps: page.steps.length,
      }),
    );
    console.log(
      'DRAWER widget:',
      JSON.stringify({
        present: drawer.present,
        headline: drawer.headline,
        title: drawer.chooserTitle,
        cards: drawer.cards.length,
        steps: drawer.steps.length,
      }),
    );

    const opened = await openDrawer(driver);
    console.log('drawer opened:', opened);
    await sleep(1500);
    const drawer2 = await readWidget(driver, 'drawer');
    console.log(
      'DRAWER(after open) widget:',
      JSON.stringify({
        present: drawer2.present,
        headline: drawer2.headline,
        title: drawer2.chooserTitle,
        cards: drawer2.cards.length,
      }),
    );

    // dump the fge mount anchors present in the DOM
    const anchors = await driver.executeScript<string>(`
      const q = (s) => !!document.querySelector(s);
      return JSON.stringify({
        mainCartItems: q('#main-cart-items'), titlePrimary: q('h1.title--primary'), cartItems: q('cart-items'),
        cartDrawer: q('cart-drawer'), CartDrawer: q('#CartDrawer'), drawerCart: q('.drawer--cart'),
        cartDrawerItems: q('cart-drawer-items'), CartDrawerItems: q('#CartDrawer-CartItems'),
        fgeSteppers: document.querySelectorAll('[data-fge-stepper]').length,
        fgeChoosers: document.querySelectorAll('[data-fge-chooser]').length,
      });
    `);
    console.log('anchors:', anchors);

    console.log('PROBE DONE');
  } catch (err) {
    console.error('PROBE FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
