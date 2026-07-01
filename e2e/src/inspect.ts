// Capture THIS theme's non-empty /cart page markup so we can optimize the widget's page-context mount
// selectors precisely. Minimal requests: preview → products.json (catalog) → one add → reload → dump.
import { buildDriver, dumpConsole, evalAsync, gotoPreview, sleep } from './browser.js';
import { addToCart, getCart } from './proxy.js';
import { loadCatalog } from './catalog.js';

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    await gotoPreview(driver, '/cart');
    await sleep(3000);

    let cart = await getCart(driver);
    if (cart.items.length === 0) {
      const cands = await loadCatalog(driver, new Set());
      for (const c of cands.slice(0, 6)) {
        const res = await addToCart(driver, c.id, 1);
        console.log('add', c.product, c.price, '->', res.status);
        await sleep(1500);
        cart = await getCart(driver);
        if (cart.items.length > 0) break;
      }
      await gotoPreview(driver, '/cart');
      await sleep(4000);
    }
    console.log('cart item_count:', (await getCart(driver)).item_count);

    const info = await evalAsync<{ heads: unknown; itemsTag: unknown; html: string }>(
      driver,
      `const q=(s)=>document.querySelector(s);
       const describe=(el)=>el?{tag:el.tagName.toLowerCase(),id:el.id||null,cls:(typeof el.className==='string'?el.className:null),section:(el.closest('.shopify-section')?el.closest('.shopify-section').id:null)}:null;
       const headSel=['h1.title--primary','.title--primary','.cart__title','.cart-title','h1','h2','.title'];
       const heads={}; for(const s of headSel) heads[s]=describe(q(s));
       const ci=q('cart-items, .cart__items, #main-cart-items');
       return { heads, itemsTag: describe(ci), html: ci ? ci.outerHTML.slice(0, 3000) : '(no cart-items)' };`,
    );
    console.log('HEADS:', JSON.stringify(info.heads, null, 1));
    console.log('ITEMS EL:', JSON.stringify(info.itemsTag));
    console.log('CART-ITEMS OUTERHTML (first 3000):\n', info.html);
    console.log('INSPECT DONE');
  } catch (err) {
    console.error('INSPECT FAILED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
