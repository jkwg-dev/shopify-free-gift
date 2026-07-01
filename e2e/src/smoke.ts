// One-off de-risking smoke: prove Selenium can drive the preview theme, the FGE embed loads, and the
// App Proxy answers. Not part of the suite (main.ts is). Run: npx tsx src/smoke.ts
import { buildDriver, dumpConsole, evalAsync, gotoPreview, waitFor } from './browser.js';
import { fetchConfig, marketContext } from './proxy.js';

async function main(): Promise<void> {
  const driver = await buildDriver();
  try {
    console.log('navigating to preview /cart ...');
    await gotoPreview(driver, '/cart');

    const url = await driver.getCurrentUrl();
    const title = await driver.getTitle();
    console.log('landed:', url, '|', title);

    // Wait for the app block marker + the bundled controller to have run (it patches window.fetch).
    const loaded = await waitFor(
      () =>
        evalAsync<{ block: boolean; script: boolean; body: boolean }>(
          driver,
          `return {
             block: !!document.querySelector('[data-fge-app-block]'),
             script: !!document.querySelector('script[src*="free-gift.js"]'),
             body: document.body.classList.contains('fge-active'),
           };`,
        ).then((s) => (s.block && s.script ? s : false)),
      { timeoutMs: 20000, label: 'fge embed present' },
    );
    console.log('embed:', loaded);

    const market = await marketContext(driver);
    console.log('market:', market);

    const config = await fetchConfig(driver);
    if (config.status !== 'active') throw new Error(`config not active: ${JSON.stringify(config)}`);
    console.log(
      'config active:',
      config.currency,
      'tiers:',
      config.tiers
        .map((t) => `#${t.position}=${t.threshold.amountMinor / 100} ${t.gift.kind}`)
        .join(', '),
    );

    console.log('SMOKE OK');
  } catch (err) {
    console.error('SMOKE FAILED:', err);
    console.error('--- browser console tail ---');
    for (const line of await dumpConsole(driver)) console.error(line);
    process.exitCode = 1;
  } finally {
    await driver.quit();
  }
}

void main();
