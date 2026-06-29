// Storefront controller: wires the PURE reconciler (5a) to the real (Dawn-derived) theme cart and,
// since Phase 5b-2a, renders the OR/variant chooser + decline checkbox from the read-only campaign
// config. On every cart change it reads the cart, calls /validate with the CURRENT chooser selection,
// and applies reconcileGiftLines' mutations (add/remove gift lines + apply/clear the code). Changing
// a choice or toggling decline re-runs the same reconcile (transactional OR re-selection).
//
// The progress graph, pending hint, drawer/mobile/a11y polish, and stale-discount auto-clear are
// Phase 5b-2b. Bundled to assets/free-gift.js by build.mjs (esbuild). Never sets prices (the minted
// code + Shopify discount do) and never trusts client state for eligibility (the server recomputes).
import {
  GIFT_LINE_PROPERTY,
  type CampaignConfigResponse,
  type CartLineView,
  type ValidateRequest,
  type ValidateResult,
} from '@free-gift-engine/core';
import { mountCartContexts, type CartSection } from './cartSections.js';
import {
  classifyAndGroup,
  giftLineKeysToRemove,
  type GroupingPlan,
  type RawCartLine,
} from './cartGrouping.js';
import { applyTwoGroupLayout, type MergedQtyChangeResult } from './groupingTransform.js';
import { applyMergedBuyEdit, failedAddVariantIds } from './cartMutations.js';
import { showNotice } from './notice.js';
import { defaultGiftChoices } from './choices.js';
import { renderChooser } from './chooser.js';
import { getConfig } from './configClient.js';
import {
  PENDING_MIN_MS,
  PENDING_MAX_MS,
  announcePending,
  pendingShouldClear,
  setCheckoutLocked,
} from './pending.js';
import { buildProgressModel, renderProgress } from './progressGraph.js';
import { reconcileGiftCart } from './reconcileLoop.js';
import { injectStyles } from './styles.js';
import { postValidate } from './validateClient.js';

const SOURCE = 'free-gift-engine';
const CART_UPDATE_EVENT = 'cart-update'; // Dawn PUB_SUB_EVENTS.cartUpdate
const DEBOUNCE_MS = 300;

type ThemeWindow = Window & {
  readonly Shopify?: {
    readonly routes?: { readonly root?: string };
    // Live presentment currency + base->presentment FX rate, updated by Shopify when the shopper
    // switches currency. Read at REQUEST-build time so a live switch is honored.
    readonly currency?: { readonly active?: string; readonly rate?: string };
  };
  readonly subscribe?: (event: string, cb: (data?: unknown) => void) => () => void;
  readonly publish?: (event: string, data?: unknown) => void;
};

type AjaxCartItem = {
  readonly key: string;
  readonly variant_id: number;
  readonly quantity: number;
  readonly properties: Readonly<Record<string, unknown>> | null;
  // Extra /cart.js fields the two-group transform needs (minor-unit integers + per-line discount
  // titles). Optional so the reconcile path is unaffected if a theme/cart omits them.
  readonly final_line_price?: number;
  readonly original_line_price?: number;
  readonly discounts?: readonly { readonly title?: string }[];
};
type AjaxCart = { readonly items: readonly AjaxCartItem[]; readonly currency: string };

type WidgetConfig = {
  readonly proxyPath: string;
  readonly country: string;
  readonly presentmentCurrency: string;
  // Optional per-theme override for portability (production theme ≠ dev snowboard theme).
  readonly drawerSelector?: string | undefined;
};

const w = window as ThemeWindow;
const root = w.Shopify?.routes?.root ?? '/';

// Shopify's live base->presentment FX rate, read FRESH per request so a storefront currency switch is
// honored. The server derives each tier's presentment threshold from it (display == enforced).
const presentmentRate = (): string | undefined => w.Shopify?.currency?.rate;

const toGid = (variantId: number): string => `gid://shopify/ProductVariant/${variantId}`;
const isGiftLine = (item: AjaxCartItem): boolean =>
  item.properties != null && item.properties[GIFT_LINE_PROPERTY] != null;

function readConfig(): WidgetConfig | null {
  const el = document.querySelector<HTMLElement>('[data-fge-app-block]');
  if (el === null) {
    return null;
  }
  return {
    proxyPath: el.dataset['proxyPath'] ?? '/apps/free-gift/validate',
    country: el.dataset['country'] ?? '',
    presentmentCurrency: el.dataset['presentmentCurrency'] ?? '',
    drawerSelector: el.dataset['drawerSelector'],
  };
}

async function getCart(): Promise<AjaxCart> {
  const res = await fetch(`${root}cart.js`, { headers: { Accept: 'application/json' } });
  return (await res.json()) as AjaxCart;
}

// Re-entrancy: our own /cart writes also fire cart events; `selfMutating` suppresses the fetch-patch
// during them, and the reconciler's idempotency guarantees convergence even if an event slips
// through. `running`/`pending` serialize overlapping triggers.
let selfMutating = false;
let running = false;
let pending = false;
let lastDiscount: string | null = null;

// Chooser-driven state (replaces the retired default_choices seam): the user's per-tier OR selection
// and the decline flag. Read by every /validate call; mutated by the chooser handlers, each of which
// triggers a reconcile so a new choice / decline is applied transactionally.
let choiceState: Record<string, string> = {};
let declined = false;

// Perception-UI state (5b-2b-1): the campaign structure (/config), the last server result (drives the
// authoritative graph), and gift variants found unavailable at runtime (cart/add 422 → disable + note).
let campaignConfig: CampaignConfigResponse | null = null;
let lastResult: ValidateResult | null = null;
const unavailableVariantIds = new Set<string>();
// One entry per present cart surface (drawer and/or full /cart page); we render the same perception UI
// into each so the widget works wherever the shopper is.
let sections: CartSection[] = [];

// Two-group line transform (Stage 1): the latest classification/merge plan + cart currency, recomputed
// after each reconcile from a fresh /cart.js read. The cartSections re-attach hook applies it to each
// surface's line list. Presentation-only — no cart write.
let lastPlan: GroupingPlan | null = null;

function toGroupingLines(cart: AjaxCart): RawCartLine[] {
  return cart.items.map((item, index) => ({
    index,
    key: item.key,
    variantId: item.variant_id,
    quantity: item.quantity,
    finalLinePrice: item.final_line_price ?? 0,
    originalLinePrice: item.original_line_price ?? 0,
    marked: isGiftLine(item),
    allocationTitles: (item.discounts ?? []).map((d) => d.title ?? '').filter((t) => t !== ''),
  }));
}

// Recompute the grouping plan from the live cart and re-apply it to every surface. Fail-open: on any
// error we keep the previous plan / the theme's untouched list. ourCode = the applied discount (the
// per-line allocation title for our BXGY code), so gets are scoped to OUR discount.
async function refreshGrouping(): Promise<void> {
  try {
    const cart = await getCart();
    lastPlan = classifyAndGroup(toGroupingLines(cart), lastDiscount);
  } catch {
    return;
  }
  for (const section of sections) {
    section.attach(); // re-applies the transform via the cartSections onReattach hook
  }
}

// Pending-indicator state (5b-2b): masks the residual gift-reconcile latency. Engaged IMMEDIATELY and
// held for at least PENDING_MIN_MS (anti-flicker), and ALWAYS cleared on a terminal outcome or the
// safety timeout (so Checkout never gets stuck). `perceptionConfig` lets the timer callbacks re-render
// without threading config through them.
let giftPendingActive = false;
let giftPendingWorkDone = false;
let giftPendingMinElapsed = false;
let giftPendingMinTimer: ReturnType<typeof setTimeout> | undefined;
let giftPendingSafetyTimer: ReturnType<typeof setTimeout> | undefined;
let perceptionConfig: WidgetConfig | null = null;

// Cart writer for applyCartPlan: POSTs JSON to an AJAX cart path and returns the raw Response (ok +
// status + text), so add/remove failures (e.g. a 422 for an unpublished gift product) are surfaced.
const cartPost = (path: string, body: unknown): Promise<Response> =>
  fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

async function postJson(path: string, body: unknown): Promise<void> {
  await cartPost(path, body);
}

// Read the live cart as reconciler lines + presentment currency.
async function readCartLines(): Promise<{ lines: CartLineView[]; currency: string }> {
  const cart = await getCart();
  const lines = cart.items.map((item) => ({
    id: item.key,
    variantId: toGid(item.variant_id),
    quantity: item.quantity,
    appAdded: isGiftLine(item),
  }));
  return { lines, currency: cart.currency };
}

async function reconcileOnce(config: WidgetConfig): Promise<void> {
  // selfMutating wraps the WHOLE convergence loop: our own cart writes must not re-trigger reconciles
  // (the loop already re-reads the live cart each pass), while a user's add that lands mid-loop is
  // still picked up by the next pass's read + re-validate. getCart / /validate are not cart writes.
  selfMutating = true;
  beginGiftPending(); // INSTANT feedback the moment the reconcile begins (held >= PENDING_MIN_MS)
  try {
    const outcome = await reconcileGiftCart(
      {
        readCart: readCartLines,
        // Server-authoritative: every line carries its app-added claim; the server EXCLUDES app-added
        // gift lines from the qualifying subtotal. Choices + decline are chooser-driven (same wire shape).
        validate: async (lines, currency) => {
          const rate = presentmentRate();
          const request: ValidateRequest = {
            cart: lines.map((l) => ({
              variantId: l.variantId,
              quantity: l.quantity,
              appAdded: l.appAdded,
            })),
            choices: choiceState,
            declined,
            presentmentCurrency: currency,
            countryCode: config.country,
            ...(rate !== undefined ? { presentmentRate: rate } : {}),
          };
          const response = await postValidate(request, { proxyPath: config.proxyPath });
          if (!response.ok) {
            return null; // null => error: leave the cart untouched
          }
          lastResult = response.result; // authoritative state for the progress graph
          // Paint the stepper THE INSTANT the confirmed subtotal is known — decoupled from the slower
          // gift remove/add/code-apply that follows in this same reconcile. Authoritative-only (the
          // server's result, never an optimistic guess). The fill then animates to the new value
          // (grow or shrink) instead of snapping after the whole sequence finishes.
          renderSteppers();
          return response.result;
        },
        post: cartPost,
        setDiscount: (code) => postJson('cart/update.js', { discount: code ?? '' }),
        // Nudge the theme to re-render its cart UI; tagged with our source so we ignore the echo.
        nudge: () => w.publish?.(CART_UPDATE_EVENT, { source: SOURCE }),
      },
      { initialCode: lastDiscount },
    );
    lastDiscount = outcome.appliedCode;
    // Runtime 422 fallback: any gift that failed to add is marked unavailable so the chooser disables
    // it (+ note) and never shows it as added. Then re-render the perception UI from server state.
    for (const variantId of failedAddVariantIds(outcome.failures)) {
      unavailableVariantIds.add(variantId);
    }
    markGiftWorkDone(); // work finished → clear once the min-duration has elapsed (whichever is later)
    renderPerception(config);
    await refreshGrouping(); // recompute + re-apply the two-group line transform from the final cart
    ensureUnmasked(); // reconcile done — grouped lines are in place (or confirmed no-gift/empty)
  } finally {
    markGiftWorkDone(); // safety: also mark done on error/throw (idempotent)
    selfMutating = false;
  }
}

// Engage the pending indicator IMMEDIATELY (instant feedback), then hold for at least PENDING_MIN_MS so
// a fast same-tier/code-only reconcile shows a brief, clean state instead of flickering. No-op when
// there's no active campaign (don't lock Checkout when there's no gift to wait for). Re-entrant: a
// chained reconcile just resets workDone so pending stays open until the new work finishes.
function beginGiftPending(): void {
  giftPendingWorkDone = false;
  if (giftPendingActive || campaignConfig === null || sections.length === 0) {
    return;
  }
  giftPendingActive = true;
  giftPendingMinElapsed = false;
  setCheckoutLocked(true); // dim + lock + spinner/message overlay (CSS)
  announcePending('Updating your free gift…'); // tell AT why Checkout is disabled
  if (perceptionConfig !== null) {
    renderPerception(perceptionConfig); // dim chooser cards + heading spinner
  }
  giftPendingMinTimer = setTimeout(() => {
    giftPendingMinElapsed = true;
    giftPendingMinTimer = undefined;
    maybeClearGiftPending();
  }, PENDING_MIN_MS);
  giftPendingSafetyTimer = setTimeout(() => clearGiftPending(), PENDING_MAX_MS);
}

// The reconcile finished (success, removal, error/422). Clear once the min-duration has also elapsed.
function markGiftWorkDone(): void {
  giftPendingWorkDone = true;
  maybeClearGiftPending();
}

function maybeClearGiftPending(): void {
  if (giftPendingActive && pendingShouldClear(giftPendingWorkDone, giftPendingMinElapsed)) {
    clearGiftPending();
  }
}

// Tear down the pending state — restores Checkout + the gift rows + the chooser. Called when work is
// done AND the min-duration elapsed, and unconditionally by the safety timeout. Idempotent.
function clearGiftPending(): void {
  if (!giftPendingActive) {
    return;
  }
  giftPendingActive = false;
  if (giftPendingMinTimer !== undefined) {
    clearTimeout(giftPendingMinTimer);
    giftPendingMinTimer = undefined;
  }
  if (giftPendingSafetyTimer !== undefined) {
    clearTimeout(giftPendingSafetyTimer);
    giftPendingSafetyTimer = undefined;
  }
  setCheckoutLocked(false); // restore "Check out" label + unlock
  announcePending(''); // clear the AT announcement
  if (perceptionConfig !== null) {
    renderPerception(perceptionConfig); // restore chooser opacity + drop the spinner
  }
}

// Render ONLY the stepper (authoritative progress) into every cart surface from the latest /validate
// result. Called the moment the confirmed subtotal is known — decoupled from the slow gift
// add/remove/code-apply — so the bar updates promptly and its CSS transition (grow AND shrink) is
// visible, rather than snapping after the whole reconcile. Idempotent: the final renderPerception
// repaints the same value (renderProgress is in-place, so no re-animation). The chooser still waits
// for the full reconcile (it reflects what's actually in the cart).
function renderSteppers(): void {
  if (campaignConfig === null || sections.length === 0) {
    return;
  }
  const model = buildProgressModel(campaignConfig, lastResult);
  for (const section of sections) {
    renderProgress(section.stepperEl, model);
    section.attach(); // no-op when already placed (idempotent) → does NOT cancel the fill transition
  }
}

// Render the progress graph + chooser into EVERY mounted cart surface (drawer and/or /cart page) from
// CURRENT server-confirmed state. The model is pure, so it's built once and painted into each context.
function renderPerception(config: WidgetConfig): void {
  if (campaignConfig === null || sections.length === 0) {
    return;
  }
  // The CURRENT (highest reached) tier is the gift the shopper receives — the chooser shows ONLY it.
  const currentTierId = lastResult?.status === 'gift' ? lastResult.tierId : null;
  const model = buildProgressModel(campaignConfig, lastResult);
  const handlers = {
    onChoose: (tierId: string, optionId: string) => {
      choiceState = { ...choiceState, [tierId]: optionId };
      renderPerception(config); // reflect the selection immediately, in every context
      schedule(config); // transactional re-validate/reconcile for the new choice
    },
    onDeclineToggle: (next: boolean) => {
      declined = next;
      renderPerception(config);
      schedule(config);
    },
  };
  for (const section of sections) {
    renderProgress(section.stepperEl, model);
    renderChooser(
      section.chooserEl,
      campaignConfig,
      { choices: choiceState, declined, unavailableVariantIds },
      handlers,
      currentTierId,
      giftPendingActive,
    );
    section.attach(); // ensure both sections are in the cart flow after rendering
  }
}

// Resolved when the reconcile single-flight goes fully idle (no run in progress, none pending). The
// merged-buy write awaits this so its cart mutation never interleaves with a reconcile's mutations.
let idleResolvers: (() => void)[] = [];

function schedule(config: WidgetConfig): void {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  void reconcileOnce(config)
    .catch(() => undefined)
    .finally(() => {
      running = false;
      if (pending) {
        pending = false;
        schedule(config);
      } else {
        const resolvers = idleResolvers;
        idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    });
}

async function whenReconcileIdle(): Promise<void> {
  // Re-checks after each settle: a chained (pending) reconcile keeps us waiting until the chain ends.
  while (running) {
    await new Promise<void>((resolve) => idleResolvers.push(resolve));
  }
}

// Refresh Dawn's footer subtotal + cart-count badge via Section Rendering (defect A revision). The
// pubsub nudge was wrong: Dawn's CartDrawerItems.onCartUpdate only re-renders ITEMS (not footer/badge),
// AND its innerHTML wipe clobbers our stepper. Instead we fetch the sections ourselves and surgically
// replace only the totals + badge — the items list is untouched, so the stepper and grouping survive.
async function refreshDawnTotals(): Promise<void> {
  try {
    const sectionIds = ['cart-drawer', 'cart-icon-bubble'];
    const pageFooterEl = document.getElementById('main-cart-footer');
    const pageFooterSection = pageFooterEl?.dataset['id'];
    if (pageFooterSection !== undefined && pageFooterSection !== '') {
      sectionIds.push(pageFooterSection);
    }
    const res = await fetch(`${root}?sections=${sectionIds.join(',')}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, string>;

    // Drawer: replace the subtotal block (.cart-drawer__footer) — NOT the whole .drawer__footer, so the
    // cart note and checkout CTA are preserved.
    const drawerHtml = data['cart-drawer'];
    if (drawerHtml !== undefined) {
      const parsed = new DOMParser().parseFromString(drawerHtml, 'text/html');
      const newTotals = parsed.querySelector('.cart-drawer__footer');
      const liveTotals = document.querySelector('cart-drawer .cart-drawer__footer');
      if (newTotals !== null && liveTotals !== null) {
        liveTotals.innerHTML = newTotals.innerHTML;
      }
    }

    // Badge: replace the cart-icon-bubble content (same pattern as Dawn's getSectionInnerHTML).
    const badgeHtml = data['cart-icon-bubble'];
    if (badgeHtml !== undefined) {
      const liveBadge = document.getElementById('cart-icon-bubble');
      if (liveBadge !== null) {
        const parsed = new DOMParser().parseFromString(badgeHtml, 'text/html');
        const newBadge = parsed.querySelector('.shopify-section');
        if (newBadge !== null) {
          (liveBadge.querySelector('.shopify-section') ?? liveBadge).innerHTML = newBadge.innerHTML;
        }
      }
    }

    // Full /cart page footer (if present): replace the .js-contents block.
    if (pageFooterSection !== undefined && pageFooterEl !== null) {
      const footerHtml = data[pageFooterSection];
      if (footerHtml !== undefined) {
        const parsed = new DOMParser().parseFromString(footerHtml, 'text/html');
        const newContent = parsed.querySelector('.js-contents');
        const liveContent = pageFooterEl.querySelector('.js-contents');
        if (newContent !== null && liveContent !== null) {
          liveContent.innerHTML = newContent.innerHTML;
        }
      }
    }
  } catch {
    // Best-effort: a failed refresh leaves stale totals (no worse than before).
  }
}

// The reconcile-owned gift line keys currently in the cart (realized $0 gets + lingering), for the
// gift-first orphan removal (defect B). Pure classification — an issue-#6 paid unit is never included.
async function currentGiftLineKeys(): Promise<readonly string[]> {
  try {
    const cart = await getCart();
    return giftLineKeysToRemove(classifyAndGroup(toGroupingLines(cart), lastDiscount));
  } catch {
    return [];
  }
}

// Surface a cart-write failure to the shopper (defect B.1). Display-only: the message text is parsed
// from the response body, but NO control flow depends on it (the retry is gated on gift-line existence).
function surfaceMergedWriteFailure(failureBody: string | null): void {
  const fallback = "Couldn't update your cart — your free gift requires this item.";
  let message = fallback;
  if (failureBody !== null) {
    try {
      const parsed = JSON.parse(failureBody) as { description?: unknown; message?: unknown };
      if (typeof parsed.description === 'string' && parsed.description !== '') {
        message = parsed.description;
      } else if (typeof parsed.message === 'string' && parsed.message !== '') {
        message = parsed.message;
      }
    } catch {
      // Non-JSON body — keep the fallback.
    }
  }
  showNotice(message);
  announcePending(message); // also announce to assistive tech
}

// Stage 2 (defect #2 + B): the interactive merged buy stepper's absolute-target write. Sequenced so it
// never overlaps a reconcile (§5): wait for reconcile idle, then run the buy edit under `selfMutating`
// (so the fetch-patch doesn't re-trigger us). The edit is buy-only first; if it 422s and the cart still
// holds gift lines, it removes the orphaned gift FIRST then applies the buy (gift-first atomic sequence,
// docs §M) so a legitimate "remove my purchase" is never VF-blocked. Write-safety: `writableKeys` are
// UNMARKED keys, and the gift removal targets only gets ∪ lingering (never a paid unit). Returns whether
// the edit applied — the stepper rolls back its optimistic UI on false. Always re-validates via reconcile.
async function onMergedBuyQtyChange(
  writableKeys: readonly string[],
  targetQty: number,
): Promise<MergedQtyChangeResult> {
  const fail: MergedQtyChangeResult = { applied: false, qty: 0, finalPrice: 0, originalPrice: 0 };
  if (perceptionConfig === null) return fail;
  // Resolve the variant from the pre-write plan (cart keys may change after write).
  const preRow = lastPlan?.buys.find(
    (r) => r.writableKeys.length > 0 && writableKeys.includes(r.writableKeys[0]!),
  );
  await whenReconcileIdle();
  selfMutating = true;
  let result: { applied: boolean; failureBody: string | null };
  try {
    result = await applyMergedBuyEdit(cartPost, writableKeys, targetQty, currentGiftLineKeys);
  } finally {
    selfMutating = false;
  }
  if (!result.applied) {
    surfaceMergedWriteFailure(result.failureBody);
  }
  // Read the authoritative post-write cart so the stepper syncs from ground truth, not a stale base.
  const cart = await getCart();
  lastPlan = classifyAndGroup(toGroupingLines(cart), lastDiscount);
  const row =
    preRow !== undefined ? lastPlan.buys.find((r) => r.variantId === preRow.variantId) : undefined;
  await refreshDawnTotals();
  schedule(perceptionConfig);
  if (!result.applied) return fail;
  return {
    applied: true,
    qty: row?.controllableQuantity ?? 0,
    finalPrice: row?.controllableFinalPrice ?? 0,
    originalPrice: row?.controllableOriginalPrice ?? 0,
  };
}

// FOUC mask: data-fge-pending is set ONCE on init and stays PERMANENTLY — it signals "FGE controls
// this region". data-fge-grouped is TOGGLED: set by applyTwoGroupLayout on success, REMOVED on each
// Dawn re-render (onReattach). The mask CSS gates on [data-fge-pending]:not([data-fge-grouped]), so
// the spinner shows whenever grouped content is not yet applied (initial load AND every re-render).
// ensureUnmasked sets data-fge-grouped for cases where no grouping applies (no-gift, timeout, no campaign).
const MASK_ATTR = 'data-fge-pending';
const GROUPED_ATTR = 'data-fge-grouped';
const MASK_TIMEOUT_MS = 2000;
let maskTimer: ReturnType<typeof setTimeout> | undefined;

function applyInitialMask(): void {
  document.querySelectorAll<HTMLElement>('cart-drawer-items, cart-items').forEach((el) => {
    el.setAttribute(MASK_ATTR, '');
  });
  maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
}

function ensureUnmasked(): void {
  if (maskTimer !== undefined) {
    clearTimeout(maskTimer);
    maskTimer = undefined;
  }
  document.querySelectorAll<HTMLElement>(`[${MASK_ATTR}]`).forEach((el) => {
    el.setAttribute(GROUPED_ATTR, '');
  });
}

function remask(itemsEl: HTMLElement | null): void {
  const host = itemsEl?.closest<HTMLElement>('cart-drawer-items, cart-items') ?? itemsEl;
  if (host !== null && host.hasAttribute(MASK_ATTR)) {
    host.removeAttribute(GROUPED_ATTR);
  }
}

// Fetch /config in parallel (Part 1) — sets the chooser state and re-schedules so the next /validate
// has the correct OR choices. Does NOT block the first reconcile.
async function loadCampaignConfig(config: WidgetConfig): Promise<void> {
  const rate = presentmentRate();
  const result = await getConfig({
    presentmentCurrency: config.presentmentCurrency,
    countryCode: config.country,
    ...(rate !== undefined ? { presentmentRate: rate } : {}),
  });
  if (!result.ok || result.config.status !== 'active') {
    ensureUnmasked(); // no active campaign → no gift possible → unmask immediately
    return;
  }
  campaignConfig = result.config;
  choiceState = defaultGiftChoices(campaignConfig.tiers);
  renderPerception(config);
  schedule(config); // re-validate with the correct choices
}

function init(): void {
  const config = readConfig();
  if (config === null) {
    return;
  }
  perceptionConfig = config; // so the pending-timer callbacks can re-render without threading config

  // Immediately: styles + cart sections (synchronous — no network wait).
  injectStyles();
  sections = mountCartContexts({
    drawerSelector: config.drawerSelector,
    onReattach: (_context, itemsEl) => {
      remask(itemsEl); // re-activate spinner until grouping applies (Dawn just replaced content)
      if (lastPlan === null) {
        return;
      }
      applyTwoGroupLayout(itemsEl, lastPlan, {
        ourCode: lastDiscount,
        onMergedQtyChange: onMergedBuyQtyChange,
      });
      // applyTwoGroupLayout sets data-fge-grouped on success → mask lifts in the same microtask
    },
  });

  // FOUC mask: dim the line-items region until the first grouping pass or timeout.
  applyInitialMask();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (data?: unknown): void => {
    // Ignore the echo of our own theme re-render publish.
    if (
      data !== null &&
      typeof data === 'object' &&
      (data as { source?: string }).source === SOURCE
    ) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => schedule(config), DEBOUNCE_MS);
  };

  // Primary: Dawn pubsub cart-update.
  w.subscribe?.(CART_UPDATE_EVENT, trigger);

  // Safety net (theme-agnostic): detect cart mutations via fetch, except our own.
  const originalFetch = w.fetch.bind(w);
  (w as { fetch: typeof fetch }).fetch = async (input, init) => {
    const result = await originalFetch(input, init);
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (!selfMutating && /\/cart\/(add|change|update|clear)(\.js)?/.test(url)) {
      trigger();
    }
    return result;
  };

  // Part 1: start the reconcile IMMEDIATELY (don't wait for /config). The first /validate may use
  // empty choices (OR tiers → no-gift), but it reads the cart + sets lastPlan so the grouping is
  // ready when the drawer opens. /config runs in parallel and re-schedules with correct choices.
  schedule(config);
  void loadCampaignConfig(config);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
