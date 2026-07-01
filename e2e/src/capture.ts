// Single-shot capture of THIS theme's non-empty /cart page HTML → saved locally for OFFLINE analysis
// (so we stop hammering the rate-limited live store). Also saves the drawer HTML. Minimal requests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDriver, dumpConsole, gotoPreview, sleep } from './browser.js';
import { addToCart, getCart } from './proxy.js';

// Known-available variant ids to seed a non-empty cart (from the live campaign config + catalog probe).
const SEED_VARIANTS = [
  45175063773374, // GFJ Essential Crew Socks Black S/M (campaign gift product, a real buyable product)
  46539010703550, // Malbon Golf Men Bermuda Rooster Tee White/S ($104)
  47669013643454, // Golf Pride MCC Plus 4 Align grip ($19.99)
];

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    mkdirSync('artifacts', { recursive: true });
    await gotoPreview(driver, '/cart');
    await sleep(3000);

    let cart = await getCart(driver);
    if (cart.items.length === 0) {
      for (const id of SEED_VARIANTS) {
        const res = await addToCart(driver, id, 1);
        console.log('seed add', id, '->', res.status);
        if (res.ok) break;
        await sleep(1500);
      }
      await sleep(2000);
      await gotoPreview(driver, '/cart');
      await sleep(4000);
      cart = await getCart(driver);
    }
    console.log('cart item_count:', cart.item_count);

    const cartHtml = await driver.executeScript<string>(
      'return document.documentElement.outerHTML;',
    );
    writeFileSync('artifacts/cart-page.html', cartHtml);
    console.log('saved artifacts/cart-page.html', cartHtml.length, 'bytes');

    // Open drawer + capture too (best-effort).
    await driver.executeScript(
      `const b=document.querySelector('#cart-icon-bubble, a[href="/cart"], .header__icon--cart'); if(b) b.click();`,
    );
    await sleep(1500);
    const drawerHtml = await driver.executeScript<string>(
      'return document.documentElement.outerHTML;',
    );
    writeFileSync('artifacts/with-drawer.html', drawerHtml);
    console.log('saved artifacts/with-drawer.html', drawerHtml.length, 'bytes');

    console.log('CAPTURE DONE');
  } catch (err) {
    console.error('CAPTURE FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
