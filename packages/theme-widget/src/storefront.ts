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
import { classifyAndGroup, type GroupingPlan, type RawCartLine } from './cartGrouping.js';
import { applyTwoGroupLayout } from './groupingTransform.js';
import { failedAddVariantIds, setMergedQuantity } from './cartMutations.js';
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

// Stage 2 (defect #2): the interactive merged buy stepper's absolute-target write. Sequenced so it
// never overlaps a reconcile (§5): wait for reconcile idle, then do ONE atomic `cart/update.js` under
// `selfMutating` (so the fetch-patch doesn't re-trigger us), then explicitly re-validate the tier — a
// drop below threshold removes the gift + clears the code (and nudges Dawn to re-render). Write-safety:
// `writableKeys` carries only UNMARKED line keys (cartGrouping ⓥ3), so a `_fge_gift` line is never
// zeroed. Reconcile only ever writes gift lines, so a user's buy edit can never be reverted.
async function onMergedBuyQtyChange(
  writableKeys: readonly string[],
  targetQty: number,
): Promise<void> {
  if (perceptionConfig === null) return;
  await whenReconcileIdle();
  selfMutating = true;
  try {
    await setMergedQuantity(cartPost, writableKeys, targetQty);
  } finally {
    selfMutating = false;
  }
  schedule(perceptionConfig); // re-validate tier for the new cart (may add/remove gifts + nudge Dawn)
}

// Inject the two perception sections into EVERY present cart surface (drawer + full /cart page): a
// stepper under the heading, the chooser by the items, re-attached on every re-render. Fetch the
// campaign structure and render. Best-effort: if config is unavailable/inactive, the engine still
// reconciles (AND tiers need no choice). The free gift renders normally in the cart list at $0 — we no
// longer hide it (role separation: the cart line confirms receipt, our chooser is progress + choice).
async function initPerception(config: WidgetConfig): Promise<void> {
  injectStyles(); // design tokens + component CSS (once)
  // Blended, in-flow sections per context (drawer and/or /cart page); re-attached on every re-render.
  // onReattach re-applies the two-group line transform on every theme re-render (Stage 1).
  sections = mountCartContexts({
    drawerSelector: config.drawerSelector,
    onReattach: (_context, itemsEl) => {
      if (lastPlan === null) {
        return;
      }
      applyTwoGroupLayout(itemsEl, lastPlan, {
        ourCode: lastDiscount,
        onMergedQtyChange: onMergedBuyQtyChange, // Stage 2: live merged +/−/delete writes
      });
    },
  });

  const rate = presentmentRate();
  const result = await getConfig({
    presentmentCurrency: config.presentmentCurrency,
    countryCode: config.country,
    ...(rate !== undefined ? { presentmentRate: rate } : {}),
  });
  if (!result.ok || result.config.status !== 'active') {
    return;
  }
  campaignConfig = result.config;
  choiceState = defaultGiftChoices(campaignConfig.tiers);
  renderPerception(config);
}

function init(): void {
  const config = readConfig();
  if (config === null) {
    return;
  }
  perceptionConfig = config; // so the pending-timer callbacks can re-render without threading config

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

  // Mount overlay + load the chooser/graph (default selection enables the gift), then reconcile.
  void initPerception(config).finally(() => schedule(config));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
