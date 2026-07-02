// E2E entrypoint: boot ONE browser on the live preview theme, confirm the FGE embed + an active
// campaign, then run the cart edge-case scenarios (each with a clean cart first). FX/multi-market
// scenarios are included when FGE_FX=1 (or explicitly via FGE_ONLY). Exits non-zero on any failure.
import { buildDriver, dumpConsole, gotoPreview, sleep, waitFor, evalAsync } from './browser.js';
import { ONLY } from './config.js';
import { allGiftProductIds, resetCart, type ActiveConfig, type Ctx } from './helpers.js';
import { fetchConfig } from './proxy.js';
import { printSummary, runAll, type Scenario } from './runner.js';
import { baseScenarios, drawerScenarios, fxScenarios } from './scenarios.js';

async function main(): Promise<void> {
  const driver = await buildDriver();
  let failed = 1;
  try {
    await gotoPreview(driver, '/cart');
    await waitFor(
      () =>
        evalAsync<boolean>(
          driver,
          `return !!document.querySelector('[data-fge-app-block]') && !!document.querySelector('script[src*="free-gift.js"]');`,
        ),
      { timeoutMs: 25000, label: 'fge embed present' },
    );

    const config = await fetchConfig(driver);
    if (config.status !== 'active') throw new Error(`campaign inactive: ${JSON.stringify(config)}`);
    const ctx: Ctx = {
      driver,
      config: config as ActiveConfig,
      giftProductIds: allGiftProductIds(config as ActiveConfig),
    };
    console.log(
      `campaign active (${config.currency}); tiers: ` +
        config.tiers
          .map((t) => `#${t.position} ${t.gift.kind} @${t.threshold.amountMinor / 100}`)
          .join(', '),
    );

    const includeFx = process.env['FGE_FX'] === '1' || ONLY.some((id) => id.startsWith('fx-'));
    const includeDrawer =
      process.env['FGE_DRAWER'] === '1' || ONLY.some((id) => id.startsWith('drawer-'));
    const all: Scenario<Ctx>[] = [
      ...baseScenarios,
      ...(includeDrawer ? drawerScenarios : []),
      ...(includeFx ? fxScenarios : []),
    ];
    const selected = ONLY.length > 0 ? all.filter((s) => ONLY.includes(s.id)) : all;
    if (selected.length === 0) throw new Error(`no scenarios matched FGE_ONLY=${ONLY.join(',')}`);

    // Per-scenario cooldown lets the App Proxy per-buyer rate-limit window drain between scenarios.
    const cooldownMs = Number(process.env['FGE_COOLDOWN_MS'] ?? 8000);
    const results = await runAll(selected, ctx, {
      before: async () => {
        await sleep(cooldownMs);
        await resetCart(driver);
      },
    });
    failed = printSummary(results);
  } catch (err) {
    console.error('SUITE ABORTED:', err);
    for (const l of await dumpConsole(driver)) console.error(l);
  } finally {
    await driver.quit();
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
