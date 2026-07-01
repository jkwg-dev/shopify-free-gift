// Shared scenario context + reconcile-wait helpers. The widget reacts to cart changes asynchronously
// (debounced 300ms, then /validate + gift add/remove + code apply), so assertions wait for a STABLE
// converged state (same snapshot twice) rather than a fixed sleep.
import { WebDriver } from 'selenium-webdriver';
import { RECONCILE_TIMEOUT_MS } from './config.js';
import { sleep, waitFor } from './browser.js';
import { CampaignConfig, Tier, ValidateResult, clearCart, numId } from './proxy.js';
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

// Derive the `choices` map the server requires from the gift lines already in the cart, mirroring what
// the widget sends. OR tier: `tierId → optionId` for the matching option (without it a qualifying OR tier
// makes /validate 400 — InvalidGiftChoiceError, the server never silently defaults a gift). AND tier:
// compound `tierId:productId → variantId` for each product whose chosen variant is in the cart (an AND
// grants one variant per product); without these the server defaults to ALL variants of every product,
// a broader code than the widget actually mints.
export function deriveChoices(
  config: ActiveConfig,
  gifts: { variantId: string }[],
): Record<string, string> {
  const chosen: Record<string, string> = {};
  const giftVariants = new Set(gifts.map((g) => g.variantId));
  for (const t of config.tiers) {
    if (t.gift.kind === 'OR') {
      const opt = t.gift.options.find((o) => giftVariants.has(o.variantId));
      if (opt !== undefined) chosen[t.tierId] = opt.optionId;
    } else {
      for (const g of t.gift.gifts) {
        if (giftVariants.has(g.variantId)) chosen[`${t.tierId}:${g.productId}`] = g.variantId;
      }
    }
  }
  return chosen;
}

// How to reselect a DIFFERENT gift in an OR tier + the variant we expect to end up with. The chooser
// renders one product per card: a different PRODUCT is a radio (value = that product's first available
// option id); a different VARIANT of the SAME product is a chip (by variant label). The auto-added
// default is the first available option, so we pick an alternate relative to it.
export type OrReselect = {
  readonly radioOptionId?: string;
  readonly chipVariantLabel?: string;
  readonly expectVariantId: string;
};
export function alternateOrTarget(tier: Tier): OrReselect | null {
  if (tier.gift.kind !== 'OR') return null;
  const avail = tier.gift.options.filter((o) => o.available);
  if (avail.length < 2) return null;
  const first = avail[0]!;
  const diffProduct = avail.find((o) => o.productId !== first.productId);
  if (diffProduct !== undefined) {
    // the radio for that product carries its FIRST available option id + variant
    const radioOpt = avail.find((o) => o.productId === diffProduct.productId)!;
    return { radioOptionId: radioOpt.optionId, expectVariantId: radioOpt.variantId };
  }
  const otherVariant = avail.find((o) => o.variantId !== first.variantId)!;
  return { chipVariantLabel: otherVariant.variantLabel, expectVariantId: otherVariant.variantId };
}

export function giftVariantIdsOf(tier: Tier): string[] {
  return tier.gift.kind === 'OR'
    ? tier.gift.options.map((o) => o.variantId)
    : tier.gift.gifts.map((g) => g.variantId);
}

// An AND tier grants ONE variant per PRODUCT (the widget's defaultGiftChoices picks one available
// variant per product), so the expected number of gift lines is the count of DISTINCT products — NOT
// the count of variants (a product's colour variants are alternatives, not all granted). Returns 0 for
// a non-AND tier.
export function andProductCount(tier: Tier): number {
  if (tier.gift.kind !== 'AND') return 0;
  return new Set(tier.gift.gifts.map((g) => g.productId)).size;
}

export function allGiftProductIds(config: ActiveConfig): Set<string> {
  const s = new Set<string>();
  for (const t of config.tiers) {
    const items = t.gift.kind === 'OR' ? t.gift.options : t.gift.gifts;
    for (const i of items) s.add(i.productId);
  }
  return s;
}

// Clear the cart and wait until the widget has reverted (no gift lines). Cart-only — no App Proxy call.
export async function resetCart(driver: WebDriver): Promise<void> {
  await clearCart(driver);
  await waitFor(async () => (await giftLines(driver)).length === 0, {
    timeoutMs: RECONCILE_TIMEOUT_MS,
    label: 'cart reset to empty (no gift lines)',
  });
}

// A converged snapshot observes ONLY the cart (/cart.js) + the widget DOM — deliberately NOT /validate,
// so the polling loop never touches the rate-limited App Proxy. Scenarios call fetchValidate ONCE after
// convergence for the code/subtotal/tier assertions.
export type Converged = {
  gifts: GiftLine[];
  widget: WidgetSnap;
};

// The widget reconciles asynchronously (debounce → /validate → cart write). To keep the request RATE
// under the store's aggressive limiter we do NOT tight-poll: we wait a fixed SETTLE first (covers the
// debounce + round-trip), then read at a WIDE interval, requiring the predicate to hold on two
// consecutive reads (stability without a busy loop). Each read is one /cart.js + DOM (no App Proxy).
const SETTLE_MS = Number(process.env['FGE_SETTLE_MS'] ?? 4000);
const POLL_MS = Number(process.env['FGE_POLL_MS'] ?? 2500);

export async function waitConverged(
  driver: WebDriver,
  predicate: (c: Converged) => boolean,
  label: string,
  context: 'page' | 'drawer' = 'page',
  timeoutMs = RECONCILE_TIMEOUT_MS,
): Promise<Converged> {
  await sleep(SETTLE_MS);
  let prevOk = false;
  return waitFor(
    async () => {
      // Read the widget DOM first (zero network). While it is reconciling (is-pending) the cart is
      // in flux, so we SKIP the /cart.js read entirely — this is the multi-second transition window
      // that otherwise dominates request volume against the store's aggressive limiter.
      const widget = await readWidget(driver, context);
      if (widget.pending) {
        prevOk = false;
        return false;
      }
      const snap: Converged = { gifts: await giftLines(driver), widget };
      const ok = predicate(snap);
      if (ok && prevOk) return snap; // two consecutive passes → stable
      prevOk = ok;
      return false;
    },
    { timeoutMs, label, intervalMs: POLL_MS },
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

// The catch-all member of ValidateResult defeats union discrimination on `subtotal`, so read it via a
// structural shape (both gift + no-gift carry an optional Money subtotal).
export function subtotalOf(v: ValidateResult): number {
  const s = (v as { subtotal?: { amountMinor: number } }).subtotal;
  return s ? s.amountMinor : 0;
}

// The applied (enforced) presentment threshold /validate reports, in minor units (0 if absent).
export function appliedThresholdOf(v: ValidateResult): number {
  const t = (v as { appliedThreshold?: { amountMinor: number } }).appliedThreshold;
  return t ? t.amountMinor : 0;
}

// Parse the first monetary amount out of a stepper headline ("Reach CA$500.00 to unlock …" → 500,
// "¥71,000 …" → 71000). Returns the DECIMAL major-unit value (currency-agnostic — thousands separators
// stripped, a single decimal point kept). Used to assert the displayed figure == the enforced figure.
export function parseHeadlineAmount(headline: string): number | null {
  const m = headline.match(/([\d.,]+\d)/);
  if (m === null) return null;
  const raw = m[1]!;
  // If there's a dot with exactly 2 trailing digits, treat as decimal; strip other separators.
  const decimalMatch = raw.match(/^(\d[\d.,]*?)([.,])(\d{2})$/);
  if (decimalMatch) {
    const intPart = decimalMatch[1]!.replace(/[.,]/g, '');
    return Number(`${intPart}.${decimalMatch[3]}`);
  }
  return Number(raw.replace(/[.,]/g, ''));
}

export { numId, sleep };
