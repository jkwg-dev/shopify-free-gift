// Shared scenario context + reconcile-wait helpers. The widget reacts to cart changes asynchronously
// (debounced 300ms, then /validate + gift add/remove + code apply), so assertions wait for a STABLE
// converged state (same snapshot twice) rather than a fixed sleep.
import { WebDriver } from 'selenium-webdriver';
import { RECONCILE_TIMEOUT_MS } from './config.js';
import { sleep, waitFor } from './browser.js';
import { CampaignConfig, Tier, ValidateResult, clearCart, fetchValidate, numId } from './proxy.js';
import { GiftLine, giftLines, readWidget, WidgetSnap } from './widget.js';

export type ActiveConfig = Extract<CampaignConfig, { status: 'active' }>;

export type Ctx = {
  driver: WebDriver;
  config: ActiveConfig;
  giftProductIds: Set<string>;
};

export function tierByPosition(config: ActiveConfig, pos: number): Tier {
  const t = config.tiers.find((x) => x.position === pos);
  if (t === undefined) throw new Error(`no tier at position ${pos}`);
  return t;
}

export function giftVariantIdsOf(tier: Tier): string[] {
  return tier.gift.kind === 'OR'
    ? tier.gift.options.map((o) => o.variantId)
    : tier.gift.gifts.map((g) => g.variantId);
}

export function allGiftProductIds(config: ActiveConfig): Set<string> {
  const s = new Set<string>();
  for (const t of config.tiers) {
    const items = t.gift.kind === 'OR' ? t.gift.options : t.gift.gifts;
    for (const i of items) s.add(i.productId);
  }
  return s;
}

// Clear the cart and wait until the widget has fully reverted (no gift lines, server says no-gift).
export async function resetCart(driver: WebDriver): Promise<void> {
  await clearCart(driver);
  await waitFor(
    async () => {
      const gl = await giftLines(driver);
      const v = await fetchValidate(driver);
      return gl.length === 0 && v.status === 'no-gift';
    },
    { timeoutMs: RECONCILE_TIMEOUT_MS, label: 'cart reset to empty/no-gift' },
  );
}

export type Converged = {
  gifts: GiftLine[];
  widget: WidgetSnap;
  validate: ValidateResult;
};

// Poll until the predicate holds on a fresh reconciled snapshot AND the snapshot is stable across two
// reads (guards against catching a mid-reconcile intermediate state).
export async function waitConverged(
  driver: WebDriver,
  predicate: (c: Converged) => boolean,
  label: string,
  context: 'page' | 'drawer' = 'page',
  timeoutMs = RECONCILE_TIMEOUT_MS,
): Promise<Converged> {
  let prevKey = '';
  let stableHit: Converged | null = null;
  return waitFor(
    async () => {
      const snap: Converged = {
        gifts: await giftLines(driver),
        widget: await readWidget(driver, context),
        validate: await fetchValidate(driver),
      };
      const key = JSON.stringify({
        g: snap.gifts.map((x) => [x.variantId, x.qty, x.finalLinePrice]).sort(),
        h: snap.widget.headline,
        c: snap.widget.chooserTitle,
        v: snap.validate.status,
      });
      const stable = key === prevKey;
      prevKey = key;
      if (stable && predicate(snap)) {
        stableHit = snap;
        return stableHit;
      }
      return false;
    },
    { timeoutMs, label, intervalMs: 500 },
  );
}

// Gift lines whose variant is in a given set (GIDs).
export function giftsInSet(gifts: GiftLine[], variantIds: Iterable<string>): GiftLine[] {
  const set = new Set([...variantIds].map((v) => v));
  return gifts.filter((g) => set.has(g.variantId));
}

export function hasVariant(gifts: GiftLine[], variantId: string): boolean {
  return gifts.some((g) => g.variantId === variantId);
}

export function subtotalOf(v: ValidateResult): number {
  if (v.status === 'gift') return v.subtotal.amountMinor;
  if (v.status === 'no-gift' && v.subtotal) return v.subtotal.amountMinor;
  return 0;
}

export { numId, sleep };
