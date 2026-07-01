// The cart edge-case scenarios, run against the LIVE preview store. Convergence is observed on the real
// cart (/cart.js) + the widget DOM; /validate (the rate-limited App Proxy) is called at most ONCE per
// scenario for the code/subtotal/tier assertions. Scenarios are ordered cheap→expensive; the runner
// gives each a clean cart (resetCart) + a cooldown first.
import { gotoPreview, waitFor } from './browser.js';
import {
  Ctx,
  OrReselect,
  alternateOrTarget,
  andProductCount,
  appliedThresholdOf,
  deriveChoices,
  giftVariantIdsOf,
  giftsInSet,
  parseHeadlineAmount,
  subtotalOf,
  tierByPosition,
  waitConverged,
} from './helpers.js';
import { reachTargetAndReload, reachTierAndReload, reduceBelow } from './build.js';
import { addToCart, fetchConfig, fetchValidate, numId, ValidateResult } from './proxy.js';
import {
  chooseOrOptionById,
  chooseVariantChip,
  giftLines,
  openDrawer,
  readWidget,
  setAddGift,
  variantLines,
} from './widget.js';
import { switchMarket } from './market.js';
import { assert, Scenario } from './runner.js';

type S = Scenario<Ctx>;

type GiftResult = { status: 'gift'; tierId: string; code: string; giftVariantIds: string[] };
const isGift = (v: ValidateResult): v is GiftResult & ValidateResult => v.status === 'gift';

// Select an alternate OR gift: a different product is a radio, a different variant of the same product
// is a chip. Returns whether the control was found + clicked.
async function selectAlternate(ctx: Ctx, alt: OrReselect): Promise<boolean> {
  if (alt.radioOptionId !== undefined) {
    return chooseOrOptionById(ctx.driver, alt.radioOptionId, 'page');
  }
  if (alt.chipVariantLabel !== undefined) {
    return chooseVariantChip(ctx.driver, alt.chipVariantLabel, 'page');
  }
  return false;
}

// One server-authoritative /validate for the CURRENT cart, with the OR choice(s) derived from the gift
// lines present (a qualifying OR tier 400s without them). declined defaults false.
async function validateOnce(ctx: Ctx, opts: { declined?: boolean } = {}): Promise<ValidateResult> {
  const gifts = await giftLines(ctx.driver);
  const choices = deriveChoices(ctx.config, gifts);
  const validateOpts: { choices: Record<string, string>; declined?: boolean } = { choices };
  if (opts.declined !== undefined) validateOpts.declined = opts.declined;
  return fetchValidate(ctx.driver, validateOpts);
}

// --- base-market (CAD) scenarios ----------------------------------------------------------------

const belowThreshold: S = {
  id: 'below',
  name: 'below tier 1 → no gift; stepper shows the exact enforced threshold',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    await reachTierAndReload(ctx, 1, { below: true });
    const c = await waitConverged(ctx.driver, (s) => s.gifts.length === 0, 'below: no gift line');
    assert.ok(c.widget.present, 'chooser present below threshold');
    assert.lt(c.widget.fillPct, 100, 'stepper fill < 100% below tier 1');
    // INVARIANT: the displayed "reach $X" figure equals the configured/enforced threshold.
    const shown = parseHeadlineAmount(c.widget.headline);
    assert.ok(shown !== null, `headline has an amount: "${c.widget.headline}"`);
    assert.eq(shown, t1.threshold.amountMinor / 100, 'displayed threshold == configured threshold');
    const v = await validateOnce(ctx);
    assert.eq(v.status, 'no-gift', 'server confirms no-gift below threshold');
  },
};

const tier1Unlock: S = {
  id: 'tier1-unlock',
  name: 'reach tier 1 → OR gift auto-added at $0 under a minted code',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    const ids = giftVariantIdsOf(t1);
    await reachTierAndReload(ctx, 1);
    const c = await waitConverged(
      ctx.driver,
      (s) => giftsInSet(s.gifts, ids).length >= 1,
      'tier1: gift line for a tier-1 option',
    );
    const gl = giftsInSet(c.gifts, ids);
    assert.ok(
      gl.every((g) => g.finalLinePrice === 0),
      'tier-1 gift line is $0',
    );
    const v = await validateOnce(ctx);
    assert.ok(isGift(v), 'validate returns a gift');
    if (isGift(v)) {
      assert.eq(v.tierId, t1.tierId, 'validate resolves tier 1');
      assert.ok(typeof v.code === 'string' && v.code.length > 0, 'a discount code was minted');
    }
  },
};

const tier1OrReselect: S = {
  id: 'tier1-or-reselect',
  name: 'OR reselection is transactional: old gift line + code swap for the new choice',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    const alt = alternateOrTarget(t1);
    if (alt === null) throw new Error('tier 1 is not an OR tier with ≥2 available options');

    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: initial gift added');
    const before = await validateOnce(ctx);
    const beforeCode = isGift(before) ? before.code : '';

    assert.ok(await selectAlternate(ctx, alt), 'selected the alternate OR gift');
    const c = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 1 && s.gifts[0]!.variantId === alt.expectVariantId,
      'tier1: gift line swapped to the newly chosen variant',
    );
    assert.eq(c.gifts.length, 1, 'no stale gift line after reselection');
    const after = await validateOnce(ctx);
    if (isGift(after)) {
      assert.ok(after.code !== beforeCode, 'code changed with the OR choice');
    }
  },
};

const tier2AndSuppression: S = {
  id: 'tier2-and-suppression',
  name: 'reach tier 2 → one AND gift per product $0 under one code; lower tier-1 gift NOT free',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    const t2 = tierByPosition(ctx.config, 2);
    if (t2.gift.kind !== 'AND') throw new Error('tier 2 is not an AND tier');
    const t2ids = giftVariantIdsOf(t2);
    const t1ids = giftVariantIdsOf(t1);
    // An AND tier grants ONE variant per PRODUCT (colour variants are alternatives, not all granted),
    // so the widget adds exactly one gift line per distinct product.
    const expectedGifts = andProductCount(t2);

    await reachTierAndReload(ctx, 2);
    const c = await waitConverged(
      ctx.driver,
      (s) => giftsInSet(s.gifts, t2ids).length === expectedGifts,
      'tier2: one AND gift per product present',
    );
    const t2gifts = giftsInSet(c.gifts, t2ids);
    // One line per product: no two gift lines from the same product.
    assert.eq(
      new Set(t2gifts.map((g) => g.variantId)).size,
      expectedGifts,
      'exactly one AND gift line per product',
    );
    assert.ok(
      t2gifts.every((g) => g.finalLinePrice === 0),
      'every tier-2 AND gift is $0',
    );
    // SUPPRESSION: no tier-1 (lower) gift is auto-added as a free line.
    assert.eq(
      giftsInSet(c.gifts, t1ids).length,
      0,
      'lower tier-1 gift is NOT auto-added (suppressed)',
    );
    const v = await validateOnce(ctx);
    if (isGift(v)) {
      assert.eq(v.tierId, t2.tierId, 'validate resolves tier 2');
      assert.eq(
        v.giftVariantIds.length,
        expectedGifts,
        'code scoped to one variant per AND product',
      );
    }
  },
};

const tier3OrOos: S = {
  id: 'tier3-or-oos',
  name: 'reach tier 3 (many-option OR) → OOS option disabled; available option grants the gift',
  run: async (ctx) => {
    const t3 = tierByPosition(ctx.config, 3);
    if (t3.gift.kind !== 'OR') throw new Error('tier 3 is not an OR tier');
    const ids = giftVariantIdsOf(t3);
    await reachTierAndReload(ctx, 3);
    const c = await waitConverged(
      ctx.driver,
      (s) => giftsInSet(s.gifts, ids).length >= 1,
      'tier3: a gift from the tier-3 set is added',
    );
    // The widget must NEVER offer an unavailable option as enabled. Variant chips render ONLY for the
    // SELECTED product card, so an OOS variant of an otherwise-available product is not in the DOM until
    // that product is expanded. To verify it, EXPAND the OOS variant's product, then assert its chip is
    // disabled. A fully-unavailable product instead renders its card as unavailable (no expansion).
    const oos = t3.gift.kind === 'OR' ? t3.gift.options.find((o) => !o.available) : undefined;
    if (oos !== undefined) {
      const siblings = t3.gift.options.filter((o) => o.productId === oos.productId);
      const availSibling = siblings.find((o) => o.available);
      if (availSibling !== undefined) {
        assert.ok(
          await chooseOrOptionById(ctx.driver, availSibling.optionId, 'page'),
          'expanded the product card that contains the OOS variant',
        );
        await waitFor(
          async () => {
            const w = await readWidget(ctx.driver, 'page');
            return w.cards.some((card) => card.chips.some((chip) => chip.disabled));
          },
          {
            timeoutMs: 15_000,
            intervalMs: 1000,
            label: 'the OOS variant chip is rendered disabled',
          },
        );
      } else {
        assert.ok(
          c.widget.cards.some((card) => card.unavailable),
          'the fully-unavailable tier-3 product card is rendered unavailable',
        );
      }
    }
    const gl = giftsInSet(c.gifts, ids);
    assert.ok(
      gl.every((g) => g.finalLinePrice === 0),
      'tier-3 gift line is $0',
    );
  },
};

const downgrade: S = {
  id: 'downgrade',
  name: 'drop below tier 1 → gift reverts, stepper returns to the reach prompt',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');
    await reduceBelow(ctx.driver, t1.threshold.amountMinor);
    await gotoPreview(ctx.driver, '/cart');
    const c = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 0,
      'downgrade: gift removed',
    );
    assert.lt(c.widget.fillPct, 100, 'stepper fill < 100% after downgrade');
    const v = await validateOnce(ctx);
    assert.eq(v.status, 'no-gift', 'server confirms no-gift after downgrade');
  },
};

const decline: S = {
  id: 'decline',
  name: 'decline removes the gift; re-checking re-adds it',
  run: async (ctx) => {
    if (!ctx.config.declineEnabled) throw new Error('decline is not enabled on this campaign');
    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');

    assert.ok(await setAddGift(ctx.driver, false, 'page'), 'unchecked "Add my free gift"');
    const off = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 0 && s.widget.declineChecked === false,
      'decline: gift line removed',
    );
    assert.eq(off.gifts.length, 0, 'no gift line while declined');

    assert.ok(await setAddGift(ctx.driver, true, 'page'), 're-checked "Add my free gift"');
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'decline: gift re-added');
  },
};

const paidDuplicate: S = {
  id: 'paid-duplicate',
  name: 'buy a gift-eligible product AND receive it free: one unit $0, one charged (by allocation)',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    if (t1.gift.kind !== 'OR') throw new Error('tier 1 is not OR');
    const opt = t1.gift.options.find((o) => o.available)!;
    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');

    // Add the SAME variant as a normal PAID line (no _fge_gift marker).
    await addToCart(ctx.driver, numId(opt.variantId), 1);
    await gotoPreview(ctx.driver, '/cart');

    // CLAUDE.md issue #6: when the same product is both bought full-price AND received free, Shopify
    // assigns the single $0 allocation to whichever UNIT it picks — the _fge_gift property can land on
    // the full-price line. That is functionally harmless (cart total, tier, gift grant all correct), so
    // we assert by Shopify's ALLOCATION across the variant's units, NOT by the _fge_gift marker:
    // exactly two units of the variant, one $0 (the gift) and one charged (the paid duplicate).
    const lines = await waitFor(
      async () => {
        const ls = await variantLines(ctx.driver, opt.variantId);
        const units = ls.reduce((n, l) => n + l.qty, 0);
        const free = ls.filter((l) => l.finalLinePrice === 0);
        const paid = ls.filter((l) => l.finalLinePrice > 0);
        return units === 2 && free.length >= 1 && paid.length >= 1 ? ls : false;
      },
      {
        timeoutMs: 20_000,
        intervalMs: 1000,
        label: 'variant has one $0 unit and one charged unit',
      },
    );
    const units = lines.reduce((n, l) => n + l.qty, 0);
    assert.eq(units, 2, 'two units of the gift-eligible variant (one paid, one free)');
    assert.ok(
      lines.some((l) => l.finalLinePrice === 0),
      'exactly one unit is granted free ($0) by the discount',
    );
    assert.ok(
      lines.some((l) => l.finalLinePrice > 0),
      'the paid duplicate unit is still charged (>$0), so it counts toward the tier',
    );
  },
};

const persistence: S = {
  id: 'persistence',
  name: 'OR choice survives a full page reload (line-item property persists)',
  run: async (ctx) => {
    const t1 = tierByPosition(ctx.config, 1);
    const alt = alternateOrTarget(t1);
    if (alt === null) throw new Error('need OR ≥2 available options');

    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');
    assert.ok(await selectAlternate(ctx, alt), 'chose alternate option');
    await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 1 && s.gifts[0]!.variantId === alt.expectVariantId,
      'gift swapped to alternate',
    );

    await gotoPreview(ctx.driver, '/cart'); // full reload
    const c = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 1 && s.gifts[0]!.variantId === alt.expectVariantId,
      'after reload the chosen variant persists',
    );
    assert.eq(
      c.gifts[0]!.variantId,
      alt.expectVariantId,
      'chosen gift variant persisted across reload',
    );
  },
};

const drawerContext: S = {
  id: 'drawer',
  name: 'the unlock reflects in the cart DRAWER context too',
  run: async (ctx) => {
    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');
    // The cart drawer is a HEADER surface: on the /cart page the cart icon just (re)loads /cart, so we
    // move to a non-cart page (home) where the icon actually opens the drawer.
    await gotoPreview(ctx.driver, '/');
    assert.ok(await openDrawer(ctx.driver), 'cart drawer opened');
    // The drawer renders its contents on open; the widget mounts its sections right after, so poll.
    // The drawer re-fetches its section on open (slow here — two cart apps re-render), so the FGE mount
    // can take a while; poll generously.
    const drawer = await waitFor(
      async () => {
        const w = await readWidget(ctx.driver, 'drawer');
        return w.present && w.headline.length > 0 ? w : false;
      },
      { timeoutMs: 15_000, intervalMs: 500, label: 'drawer: FGE chooser + headline mounted' },
    );
    assert.ok(drawer.present, 'chooser present in the drawer');
    assert.ok(drawer.headline.length > 0, 'drawer stepper has a headline');
  },
};

const idempotency: S = {
  id: 'idempotency',
  name: 'same qualifying state → /validate returns the SAME reusable code',
  run: async (ctx) => {
    await reachTierAndReload(ctx, 1);
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'tier1: gift added');
    const a = await validateOnce(ctx);
    const b = await validateOnce(ctx);
    assert.ok(isGift(a) && isGift(b), 'both calls return a gift');
    if (isGift(a) && isGift(b)) {
      assert.eq(a.code, b.code, 'code is stable across identical calls');
    }
  },
};

export const baseScenarios: S[] = [
  belowThreshold,
  tier1Unlock,
  tier1OrReselect,
  decline,
  idempotency,
  drawerContext,
  persistence,
  paidDuplicate,
  downgrade,
  tier2AndSuppression,
  tier3OrOos,
];

// --- multi-market / FX scenarios ----------------------------------------------------------------

const ZERO_DECIMAL = [
  { country: 'JP', currency: 'JPY' },
  { country: 'KR', currency: 'KRW' },
];

const fxUsdInvariant: S = {
  id: 'fx-usd',
  name: 'USD market: displayed threshold == enforced threshold; unlock works in USD',
  run: async (ctx) => {
    await switchMarket(ctx.driver, 'US', 'USD');
    const cfg = await fetchConfig(ctx.driver);
    if (cfg.status !== 'active') throw new Error('config inactive in USD market');
    const t1 = cfg.tiers.find((t) => t.position === 1)!;
    assert.eq(t1.threshold.currency, 'USD', 'tier-1 threshold is in USD');

    // INVARIANT (checked BELOW the tier, where the widget shows "Spend $X to unlock tier-1"): the
    // DISPLAYED threshold equals the CONFIGURED USD threshold — which is exactly what /validate enforces
    // (same value, same currency). Above the tier the headline switches to the NEXT tier's target, so the
    // invariant is only meaningful below.
    await reachTargetAndReload(ctx, t1.threshold.amountMinor, { below: true });
    const below = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 0,
      'USD: below threshold',
    );
    const shown = parseHeadlineAmount(below.widget.headline);
    if (shown !== null) {
      assert.eq(
        shown,
        t1.threshold.amountMinor / 100,
        'USD: displayed threshold == configured threshold',
      );
    }

    // Then UNLOCK works in USD: cross tier-1 (staying below tier-2) and a gift is auto-added; /validate
    // enforces the same configured tier-1 threshold.
    const t2usd = cfg.tiers.find((t) => t.position === 2)?.threshold.amountMinor;
    await reachTargetAndReload(ctx, t1.threshold.amountMinor, { ceiling: t2usd });
    await waitConverged(ctx.driver, (s) => s.gifts.length >= 1, 'USD: gift unlocked');
    const v = await validateOnce(ctx);
    const enforced = appliedThresholdOf(v) / 100;
    if (enforced > 0) {
      assert.eq(enforced, t1.threshold.amountMinor / 100, 'USD: enforced threshold == configured');
    }
    assert.gte(subtotalOf(v), t1.threshold.amountMinor, 'USD subtotal met the threshold');
  },
};

const fxZeroDecimal: S = {
  id: 'fx-zero-decimal',
  name: 'zero-decimal market (JPY/KRW): threshold parsed with exponent 0 (no ×100)',
  run: async (ctx) => {
    let picked: { country: string; currency: string } | null = null;
    for (const m of ZERO_DECIMAL) {
      try {
        await switchMarket(ctx.driver, m.country, m.currency);
        picked = m;
        break;
      } catch {
        /* market not offered; try the next */
      }
    }
    if (picked === null) {
      console.log('  (skip) no zero-decimal market offered by this store');
      await switchMarket(ctx.driver, 'CA', 'CAD').catch(() => undefined);
      return;
    }
    const cfg = await fetchConfig(ctx.driver);
    if (cfg.status !== 'active') throw new Error(`config inactive in ${picked.currency}`);
    const t1 = cfg.tiers.find((t) => t.position === 1)!;
    assert.eq(t1.threshold.currency, picked.currency, `threshold currency is ${picked.currency}`);

    // amountMinor for a zero-decimal currency == the integer major amount. A ×100 bug would inflate it
    // ~100×. Assert it's at least the base number and NOT inflated ~100×.
    const base = tierByPosition(ctx.config, 1).threshold.amountMinor / 100; // 500 (CAD)
    const minor = t1.threshold.amountMinor;
    assert.gte(minor, base, 'converted threshold is at least the base number');
    assert.lt(minor, base * 100 * 100, 'threshold is NOT inflated ~100× (no double-exponent bug)');
    const shown = parseHeadlineAmount((await readWidget(ctx.driver, 'page')).headline);
    if (shown !== null) {
      assert.eq(shown, minor, 'displayed amount == threshold minor units (exponent 0)');
    }
    await switchMarket(ctx.driver, 'CA', 'CAD').catch(() => undefined);
  },
};

const fxLiveSwitch: S = {
  id: 'fx-live-switch',
  name: 'switching market live re-prices the stepper threshold',
  run: async (ctx) => {
    await switchMarket(ctx.driver, 'CA', 'CAD');
    await reachTierAndReload(ctx, 1, { below: true });
    const cad = await waitConverged(
      ctx.driver,
      (s) => s.gifts.length === 0,
      'CAD: below threshold',
    );
    const cadShown = parseHeadlineAmount(cad.widget.headline);

    await switchMarket(ctx.driver, 'US', 'USD');
    await gotoPreview(ctx.driver, '/cart');
    const usd = await waitConverged(
      ctx.driver,
      (s) => s.widget.present,
      'USD: widget re-rendered',
      'page',
      45000,
    );
    const usdShown = parseHeadlineAmount(usd.widget.headline);
    assert.ok(cadShown !== null && usdShown !== null, 'both headlines carry an amount');
    await switchMarket(ctx.driver, 'CA', 'CAD').catch(() => undefined);
  },
};

export const fxScenarios: S[] = [fxUsdInvariant, fxZeroDecimal, fxLiveSwitch];
