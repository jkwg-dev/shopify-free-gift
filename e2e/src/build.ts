// Scenario-level cart building: reach a tier's qualifying subtotal, then RELOAD the preview /cart so
// the widget re-mounts and reconciles from a clean DOM (deterministic). Also a live "downgrade" helper
// that reduces existing buy lines below a target (tests the qualified → below transition without a
// full clear).
import { WebDriver } from 'selenium-webdriver';
import { gotoPreview } from './browser.js';
import { RECONCILE_TIMEOUT_MS } from './config.js';
import { buildSubtotal } from './catalog.js';
import { changeLine, getCart } from './proxy.js';
import { Ctx, tierByPosition } from './helpers.js';

// Qualifying subtotal from /cart.js (non-gift line finals) — cart-local, no App Proxy call.
async function cartSubtotalMinor(driver: WebDriver): Promise<number> {
  const cart = await getCart(driver);
  return cart.items
    .filter((it) => !(it.properties && it.properties['_fge_gift'] != null))
    .reduce((n, it) => n + it.final_line_price, 0);
}

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
  // The next tier's threshold is the CEILING: the build must land in [target, ceiling) so it qualifies
  // for THIS tier without spilling into the next. Top tier → no ceiling.
  const next = ctx.config.tiers.find((t) => t.position === pos + 1);
  const ceiling = next?.threshold.amountMinor;
  const r = await buildSubtotal(ctx.driver, target, ctx.giftProductIds, { ...opts, ceiling });
  await gotoPreview(ctx.driver, '/cart');
  return r.subtotalMinor;
}

// Build to an ABSOLUTE target (minor units) and reload — for multi-currency where the target is the
// market's converted threshold.
export async function reachTargetAndReload(
  ctx: Ctx,
  target: number,
  opts: { below?: boolean; ceiling?: number } = {},
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
    const s = await cartSubtotalMinor(driver);
    if (s < target) return s;
    if (guard++ > 200) return s;
    const cart = await getCart(driver);
    const buy = cart.items
      .filter((it) => !(it.properties && it.properties['_fge_gift'] != null))
      .sort((a, b) => b.quantity - a.quantity)[0];
    if (buy === undefined) return s;
    // remove a whole large-qty line at once when it alone exceeds the target overshoot, else step down
    await changeLine(driver, buy.key, Math.max(0, buy.quantity - 1));
  }
}

export { RECONCILE_TIMEOUT_MS };
