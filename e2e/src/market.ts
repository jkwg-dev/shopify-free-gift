// Multi-market switching. This is exactly what the storefront's top-bar country/currency selector
// does: it submits the localization form (PUT /localization with a country_code), Shopify sets the
// market cookie, and the store reprices in that market's presentment currency + exposes
// window.Shopify.currency = { active, rate }. We drive that form directly (reliable in headless), then
// reload the preview /cart and confirm the currency flipped.
import { WebDriver } from 'selenium-webdriver';
import { evalAsync, gotoPreview, waitFor } from './browser.js';
import { marketContext } from './proxy.js';

export async function switchMarket(
  driver: WebDriver,
  countryCode: string,
  expectedCurrency: string,
): Promise<{ active: string; rate: string | null }> {
  // Post the localization change the same way the top-bar selector's form does (no top-frame
  // navigation → no script race), then reload the preview cart so the new market takes effect.
  await evalAsync<string>(
    driver,
    `const body = new URLSearchParams();
     body.set('_method', 'put');
     body.set('country_code', arguments[0]);
     body.set('return_to', '/cart');
     await fetch('/localization', {
       method: 'POST',
       headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
       body: body.toString(),
       redirect: 'follow',
     });
     return 'ok';`,
    countryCode,
  );

  await gotoPreview(driver, '/cart');

  return waitFor(
    async () => {
      const m = await marketContext(driver);
      return m.active === expectedCurrency ? m : false;
    },
    { timeoutMs: 20000, label: `market switch to ${expectedCurrency}` },
  );
}
