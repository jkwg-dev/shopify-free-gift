// Post-deploy live check: confirm the running bundle is the new extension version and that the
// PAGE-context tier stepper now mounts on the live theme's /cart page (the bug we fixed). Gentle:
// one navigation + one add (only if the cart is empty) to render the non-empty cart page.
import { buildDriver, dumpConsole, evalAsync, gotoPreview, sleep } from './browser.js';
import { addToCart, getCart } from './proxy.js';

const SEED = 45175063773374; // GFJ Essential Crew Socks Black S/M (available)

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    await gotoPreview(driver, '/cart');
    await sleep(3000);
    if ((await getCart(driver)).items.length === 0) {
      await addToCart(driver, SEED, 1);
      await sleep(1500);
      await gotoPreview(driver, '/cart');
      await sleep(4000);
    }

    const info = await evalAsync<{
      bundleSrc: string | null;
      pageSection: boolean;
      pageStepper: number;
      pageChooser: number;
      drawerStepper: number;
      totalStepper: number;
      totalChooser: number;
      stepperHeadline: string | null;
    }>(
      driver,
      `const s=[...document.querySelectorAll('script[src*="free-gift.js"]')][0];
       const pageSec=document.querySelector('#main-cart-items')?.closest('.shopify-section')||null;
       const inSec=(sel)=> pageSec ? pageSec.querySelectorAll(sel).length : 0;
       const drawer=document.querySelector('cart-drawer,.cart-drawer')?.closest('.shopify-section')||null;
       const step=pageSec?pageSec.querySelector('[data-fge-stepper] .fge-headline'):null;
       return {
         bundleSrc: s?s.getAttribute('src'):null,
         pageSection: !!pageSec,
         pageStepper: inSec('[data-fge-stepper]'),
         pageChooser: inSec('[data-fge-chooser]'),
         drawerStepper: drawer?drawer.querySelectorAll('[data-fge-stepper]').length:0,
         totalStepper: document.querySelectorAll('[data-fge-stepper]').length,
         totalChooser: document.querySelectorAll('[data-fge-chooser]').length,
         stepperHeadline: step?step.textContent.trim():null,
       };`,
    );
    console.log('VERIFY:', JSON.stringify(info, null, 2));
    console.log(
      info.pageStepper >= 1
        ? '✅ PAGE STEPPER MOUNTED — cart-page tier graph fix is LIVE'
        : '❌ page stepper still missing',
    );
  } catch (err) {
    console.error('VERIFY FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
