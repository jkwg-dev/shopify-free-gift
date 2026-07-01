// Scenario-level cart building: reach a tier's qualifying subtotal, then RELOAD the preview /cart so
// the widget re-mounts and reconciles from a clean DOM (deterministic). Also a live "downgrade" helper
// that reduces existing buy lines below a target (tests the qualified → below transition without a
// full clear).
import { WebDriver } from 'selenium-webdriver';
import { gotoPreview } from './browser.js';
import { RECONCILE_TIMEOUT_MS } from './config.js';
import { buildSubtotal } from './catalog.js';
import { changeLine, fetchValidate, getCart } from './proxy.js';
import { Ctx, subtotalOf, tierByPosition } from './helpers.js';

export async function thresholdOf(ctx: Ctx, pos: number): Promise<number> {
  return tierByPosition(ctx.config, pos).threshold.amountMinor;
}

// Build to a tier by position and reload the cart page. Returns achieved subtotal.
export async function reachTierAndReload(
  ctx: Ctx,
  pos: number,
  opts: { below?: boolean } = {},
): Promise<number> {
  const target = tierByPosition(ctx.config, pos).threshold.amountMinor;
  const r = await buildSubtotal(ctx.driver, target, ctx.giftProductIds, opts);
  await gotoPreview(ctx.driver, '/cart');
  return r.subtotalMinor;
}

// Build to an ABSOLUTE target (minor units) and reload — for multi-currency where the target is the
// market's converted threshold.
export async function reachTargetAndReload(
  ctx: Ctx,
  target: number,
  opts: { below?: boolean } = {},
): Promise<number> {
  const r = await buildSubtotal(ctx.driver, target, ctx.giftProductIds, opts);
  await gotoPreview(ctx.driver, '/cart');
  return r.subtotalMinor;
}

// Reduce existing NON-gift lines until the server subtotal is strictly below `target`. Decrements the
// largest-quantity buy line repeatedly. Used by the downgrade scenario.
export async function reduceBelow(driver: WebDriver, target: number): Promise<number> {
  let guard = 0;
  for (;;) {
    const v = await fetchValidate(driver);
    if (subtotalOf(v) < target) return subtotalOf(v);
    if (guard++ > 200) return subtotalOf(v);
    const cart = await getCart(driver);
    const buy = cart.items
      .filter((it) => !(it.properties && it.properties['_fge_gift'] != null))
      .sort((a, b) => b.quantity - a.quantity)[0];
    if (buy === undefined) return subtotalOf(v);
    await changeLine(driver, buy.key, Math.max(0, buy.quantity - 1));
  }
}

export { RECONCILE_TIMEOUT_MS };
