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
import { applyGiftLineHiding, syncNativeInputs } from './groupingTransform.js';
import { failedAddVariantIds } from './cartMutations.js';
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
import { replaceDrawerFooter, stampAuthoritativeCart } from './drawerRefresh.js';

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
type AjaxCart = {
  readonly items: readonly AjaxCartItem[];
  readonly currency: string;
  readonly total_price?: number;
  readonly item_count?: number;
};

type WidgetConfig = {
  readonly proxyPath: string;
  readonly country: string;
  readonly presentmentCurrency: string;
  // Optional per-theme override for portability (production theme ≠ dev snowboard theme).
  readonly drawerSelector?: string | undefined;
};

const w = window as ThemeWindow;
const root = w.Shopify?.routes?.root ?? '/';

// Drawer PANEL selector — excludes buttons/triggers whose class contains "cart-drawer" (e.g.
// `.quick-cart-drawer__trigger`) that can false-positive into the wrong shopify-section.
const DRAWER_PANEL_SELECTOR =
  'cart-drawer, #CartDrawer, .cart-drawer:not(button):not([class*="__trigger"]), .drawer--cart';

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

// Gift-line hide plan: recomputed after each reconcile from /cart.js. cartSections re-attach applies it.
let lastPlan: GroupingPlan | null = null;
// Coalesce overlapping display-reconcile calls (theme MO + reconcile finish can overlap).
let displayReconcileInFlight: Promise<void> | null = null;

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

let lastCartQuantities: readonly number[] = [];

// Extract numeric variant IDs from DOM `.cart-item` nodes' product links (a[href*="variant="]).
// Returns a sorted array so two multisets can be compared with JSON equality.
function domVariantIds(itemsEl: HTMLElement | null): number[] {
  if (itemsEl === null) return [];
  const ids: number[] = [];
  const nodes = itemsEl.querySelectorAll<HTMLElement>(
    '.cart-item, [id^="CartDrawer-Item-"], [id^="CartItem-"], cart-item, .cart__row',
  );
  for (const node of nodes) {
    const link = node.querySelector<HTMLAnchorElement>('a[href*="variant="]');
    if (link !== null) {
      const m = link.href.match(/variant=(\d+)/);
      if (m !== null) ids.push(Number(m[1]));
    }
  }
  return ids.sort((a, b) => a - b);
}

// Compare DOM variant multiset to cart.js variant multiset. Returns true if they match exactly.
function domMatchesCart(itemsEl: HTMLElement | null, cart: AjaxCart): boolean {
  const domIds = domVariantIds(itemsEl);
  const cartIds = cart.items.map((item) => item.variant_id).sort((a, b) => a - b);
  if (domIds.length !== cartIds.length) return false;
  for (let i = 0; i < domIds.length; i++) {
    if (domIds[i] !== cartIds[i]) return false;
  }
  return true;
}

// Force a section-fetch replacement of the drawer items list. Called when the DOM variant set
// diverges from cart.js (stale/duplicate nodes, missing buy nodes). Replaces only the items
// container, then re-applies grouping. Retries up to `maxAttempts` with a short backoff to handle
// the stale-section-render race.
async function refreshItemsBody(cart: AjaxCart): Promise<{ ok: boolean; drawerHtml?: string }> {
  const drawerSectionId = detectDrawerSectionId();
  const maxAttempts = 2;
  let lastDrawerHtml: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 200));
      const res = await fetch(`${root}?sections=${drawerSectionId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, string>;
      const html = data[drawerSectionId];
      if (html === undefined) continue;
      lastDrawerHtml = html;

      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const ITEMS_SELECTORS = ['cart-drawer-items', '[data-cart-items]', '.cart-drawer__items'];
      for (const sel of ITEMS_SELECTORS) {
        const newItems = parsed.querySelector(sel);
        const liveItems = document.querySelector(sel);
        if (newItems !== null && liveItems !== null) {
          liveItems.innerHTML = newItems.innerHTML;
          if (domMatchesCart(liveItems as HTMLElement, cart)) {
            return { ok: true, drawerHtml: html };
          }
          break;
        }
      }
    } catch {
      // retry
    }
  }
  // Fallback: could not converge. Remove DOM nodes whose variant is not in cart.js.
  const itemsEl = document.querySelector<HTMLElement>('cart-drawer-items, cart-items');
  if (itemsEl !== null) {
    const cartVariants = new Set(cart.items.map((item) => item.variant_id));
    const nodes = Array.from(
      itemsEl.querySelectorAll<HTMLElement>(
        '.cart-item, [id^="CartDrawer-Item-"], [id^="CartItem-"], cart-item, .cart__row',
      ),
    );
    for (const node of nodes) {
      const link = node.querySelector<HTMLAnchorElement>('a[href*="variant="]');
      if (link !== null) {
        const m = link.href.match(/variant=(\d+)/);
        if (m !== null && !cartVariants.has(Number(m[1]))) {
          node.remove();
        }
      }
    }
    console.warn('[FGE-DRAWERFIX] body refetch could not converge', {
      domKeys: domVariantIds(itemsEl),
      cartKeys: cart.items.map((i) => i.variant_id),
    });
  }
  return lastDrawerHtml !== undefined ? { ok: false, drawerHtml: lastDrawerHtml } : { ok: false };
}

// Verified display reconcile: cart.js read → grouping + stamp → optional section corrections.
// forceItemsRefresh: after FGE cart writes (gift/discount), Dawn keeps stale line keys in the DOM;
// section-fetch the items body so qty steppers target live keys (variant multiset can still match).
async function doVerifiedDisplayReconcile(
  cartMutated: boolean,
  existingCart?: AjaxCart,
  forceItemsRefresh = false,
): Promise<void> {
  const cart = existingCart ?? (await getCart());

  lastPlan = classifyAndGroup(toGroupingLines(cart), lastDiscount);
  lastCartQuantities = cart.items.map((item) => item.quantity);
  for (const section of sections) section.attach();

  const giftQty = cart.items.filter(isGiftLine).reduce((n, item) => n + item.quantity, 0);
  const buyOnlyCount = (cart.item_count ?? 0) - giftQty;
  if (cart.total_price !== undefined && cart.item_count !== undefined) {
    stampAuthoritativeCart({ total_price: cart.total_price, item_count: buyOnlyCount });
  }

  const itemsEl = document.querySelector<HTMLElement>('cart-drawer-items, cart-items');
  let prefetchedDrawerHtml: string | undefined;
  if (forceItemsRefresh || !domMatchesCart(itemsEl, cart)) {
    if (forceItemsRefresh && domMatchesCart(itemsEl, cart)) {
      console.warn(
        '[FGE-DRAWERFIX] refreshing items body after FGE cart write (line keys may be stale)',
      );
    } else if (!domMatchesCart(itemsEl, cart)) {
      console.warn('[FGE-DRAWERFIX] DOM/cart divergence detected, forcing body refetch');
    }
    const bodyRefresh = await refreshItemsBody(cart);
    prefetchedDrawerHtml = bodyRefresh.drawerHtml;
    for (const section of sections) section.attach();
  }

  // Sync qty inputs only here — after lastCartQuantities is refreshed from cart.js. onReattach also
  // runs on Dawn's optimistic +/- repaints and on gift-pending re-attaches; syncing there reverted
  // the theme's in-flight quantity and caused a visible flicker.
  syncNativeInputs(itemsEl, lastCartQuantities);

  if (cartMutated) {
    await refreshDawnTotals(prefetchedDrawerHtml);
  }
}

function verifiedDisplayReconcile(
  cartMutated = false,
  existingCart?: AjaxCart,
  forceItemsRefresh = false,
): Promise<void> {
  if (displayReconcileInFlight !== null) {
    return displayReconcileInFlight;
  }
  displayReconcileInFlight = doVerifiedDisplayReconcile(
    cartMutated,
    existingCart,
    forceItemsRefresh,
  )
    .catch(() => undefined)
    .finally(() => {
      displayReconcileInFlight = null;
    });
  return displayReconcileInFlight;
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
    finalLinePrice: item.final_line_price ?? 0,
    hasDiscountAllocation: (item.discounts?.length ?? 0) > 0,
  }));
  return { lines, currency: cart.currency };
}

async function reconcileOnce(config: WidgetConfig): Promise<void> {
  // selfMutating wraps the WHOLE convergence loop: our own cart writes must not re-trigger reconciles
  // (the loop already re-reads the live cart each pass), while a user's add that lands mid-loop is
  // still picked up by the next pass's read + re-validate. getCart / /validate are not cart writes.
  selfMutating = true;
  beginGiftPending(); // INSTANT feedback the moment the reconcile begins (held >= PENDING_MIN_MS)
  const lastPriorCode = lastDiscount;
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
              hasDiscountAllocation: l.hasDiscountAllocation ?? false,
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
    renderPerception(config);
    const cartMutated = outcome.passes > 1 || outcome.appliedCode !== lastPriorCode;
    const cart = await getCart();
    await verifiedDisplayReconcile(cartMutated, cart, outcome.wroteCart);
  } finally {
    markGiftWorkDone(); // clear checkout lock only after display reconcile finishes
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

function cartHost(itemsEl: HTMLElement | null): HTMLElement | null {
  return itemsEl?.closest<HTMLElement>('cart-drawer-items, cart-items') ?? itemsEl;
}

// Hide raw theme cart content until the FGE transform runs. Always strips data-fge-grouped first so
// a stale grouped flag cannot skip the CSS mask after a theme section re-render.
const MASK_ATTR = 'data-fge-pending';
const GROUPED_ATTR = 'data-fge-grouped';
const EMPTY_NATIVE_ATTR = 'data-fge-empty-native';
const MASK_TIMEOUT_MS = 1000;
let maskTimer: ReturnType<typeof setTimeout> | undefined;

function cartHasFgeLines(): boolean {
  return lastPlan === null || lastPlan.lineCount > 0;
}

// Empty cart: lift the fge-active hide without grouping — show the theme's native empty state.
function showNativeEmptyCart(host: HTMLElement | null): void {
  if (host === null) return;
  host.removeAttribute(GROUPED_ATTR);
  host.removeAttribute(MASK_ATTR);
  host.setAttribute(EMPTY_NATIVE_ATTR, '');
}

function maskCartHost(host: HTMLElement | null): void {
  if (host === null) return;
  host.removeAttribute(EMPTY_NATIVE_ATTR);
  host.removeAttribute(GROUPED_ATTR);
  host.setAttribute(MASK_ATTR, '');
  if (maskTimer === undefined) {
    maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
  }
}

function maskAllCartHosts(): void {
  document.querySelectorAll<HTMLElement>('cart-drawer-items, cart-items').forEach((el) => {
    maskCartHost(el);
  });
}

// Apply the current grouping plan synchronously. On line-count mismatch, keep masked — the in-flight
// reconcile (or the next cart event) will re-attach with a fresh plan; never spawn a nested reconcile.
function applyFgeCartDisplay(itemsEl: HTMLElement | null): void {
  if (lastPlan === null) return;
  if (lastPlan.lineCount === 0) {
    showNativeEmptyCart(cartHost(itemsEl));
    return;
  }
  if (applyGiftLineHiding(itemsEl, lastPlan)) return;
  maskCartHost(cartHost(itemsEl));
}

// Observe the cart drawer for OPEN: Dawn adds 'active' class on open (synchronous via setTimeout(0)).
// A MutationObserver on class-attribute fires in the microtask queue — before the browser paints — so
// we mask ungrouped content at the exact moment the drawer becomes visible.
function observeDrawerOpen(): void {
  const drawer = document.querySelector<HTMLElement>(DRAWER_PANEL_SELECTOR);
  if (drawer === null) return;
  new MutationObserver(() => {
    if (drawer.classList.contains('active')) {
      if (cartHasFgeLines()) {
        maskAllCartHosts();
      } else {
        document
          .querySelectorAll<HTMLElement>('cart-drawer-items, cart-items')
          .forEach((el) => showNativeEmptyCart(el));
      }
      // On drawer open, run the verified display reconcile: compare DOM to cart.js, force a body
      // re-fetch if divergent, then apply grouping + stamp. Never shows a frozen prior render.
      void verifiedDisplayReconcile();
    }
  }).observe(drawer, { attributes: true, attributeFilter: ['class'] });
}

function schedule(config: WidgetConfig): void {
  if (running) {
    pending = true;
    if (cartHasFgeLines()) {
      maskAllCartHosts();
    }
    return;
  }
  if (cartHasFgeLines()) {
    maskAllCartHosts();
  }
  running = true;
  void reconcileOnce(config)
    .catch(() => undefined)
    .finally(() => {
      running = false;
      if (pending) {
        pending = false;
        schedule(config);
      }
    });
}

let cachedDrawerSectionId: string | null = null;

// Detect the Shopify section ID for the cart drawer from the live DOM. Anchored on the items
// container (#CartDrawer-Body, cart-drawer-items) — the node the refetch needs to replace — so it
// returns the section that actually contains cart line items, never a recommendations or trigger
// button section. Cached after the first successful detection (the section ID never changes).
function detectDrawerSectionId(): string {
  if (cachedDrawerSectionId !== null) return cachedDrawerSectionId;
  // Primary: walk up from the items container — authoritative because it IS the cart content.
  const itemsAnchors = [
    '#CartDrawer-Body',
    'cart-drawer-items',
    '.cart-drawer__items',
    '[data-cart-body]',
    '[data-cart-items]',
  ];
  for (const sel of itemsAnchors) {
    const el = document.querySelector(sel);
    if (el !== null) {
      const section = el.closest<HTMLElement>('[id^="shopify-section-"]');
      if (section !== null) {
        cachedDrawerSectionId = section.id.replace('shopify-section-', '');
        return cachedDrawerSectionId;
      }
    }
  }
  // Fallback: drawer panel detection, excluding buttons/triggers that can false-positive.
  const drawer = document.querySelector(DRAWER_PANEL_SELECTOR);
  if (drawer !== null) {
    const section =
      drawer.closest<HTMLElement>('[id^="shopify-section-"]') ??
      drawer.querySelector<HTMLElement>('[id^="shopify-section-"]');
    if (section !== null) {
      const id = section.id.replace('shopify-section-', '');
      if (section.querySelector('.cart-item, #CartDrawer-Body, cart-drawer-items') !== null) {
        cachedDrawerSectionId = id;
        return id;
      }
      console.warn('[FGE-DRAWERFIX] drawer section misdetected ->', id);
    }
    const dataId =
      drawer.closest<HTMLElement>('[data-section-id]')?.dataset['sectionId'] ??
      (drawer as HTMLElement).dataset?.['sectionId'];
    if (dataId !== undefined && dataId !== '') {
      cachedDrawerSectionId = dataId;
      return dataId;
    }
  }
  return 'cart-drawer';
}

// Detect the section ID for the cart icon badge. Same pattern as the drawer.
function detectBadgeSectionId(): string {
  const bubble = document.getElementById('cart-icon-bubble');
  if (bubble !== null) {
    const section = bubble.closest<HTMLElement>('[id^="shopify-section-"]');
    if (section !== null) return section.id.replace('shopify-section-', '');
  }
  return 'cart-icon-bubble';
}

// Refresh the cart drawer's FOOTER + cart-count badge via Section Rendering. The items container is
// left untouched — it is owned by Dawn's own cart-update repaint + the FGE grouping transform.
// After applying the section HTML, authoritative cart.js values are stamped into the subtotal and
// badge so a stale section response (fetched before the discount settles) never shows wrong numbers.
// Section-fetch refresh for footer + badge. Accepts an already-fetched cart to avoid a redundant
// getCart() (the caller already read cart.js for the verified display reconcile).
// Reuse drawer section HTML from refreshItemsBody when available — avoids a duplicate section fetch.
async function refreshDawnTotals(prefetchedDrawerHtml?: string): Promise<void> {
  try {
    const drawerSectionId = detectDrawerSectionId();
    const badgeSectionId = detectBadgeSectionId();
    const pageFooterEl = document.getElementById('main-cart-footer');
    const pageFooterSection = pageFooterEl?.dataset['id'];

    const sectionIds = [badgeSectionId];
    if (pageFooterSection !== undefined && pageFooterSection !== '') {
      sectionIds.push(pageFooterSection);
    }
    if (prefetchedDrawerHtml === undefined) {
      sectionIds.unshift(drawerSectionId);
    }

    const res = await fetch(`${root}?sections=${sectionIds.join(',')}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, string>;

    applyBadgeAndPageFooter(data, badgeSectionId, pageFooterEl, pageFooterSection);

    const drawerHtml = prefetchedDrawerHtml ?? data[drawerSectionId];
    if (drawerHtml !== undefined) replaceDrawerFooter(drawerHtml);
  } catch {
    // Best-effort.
  }
}

function applyPageFooter(
  data: Record<string, string>,
  pageFooterEl: HTMLElement | null,
  pageFooterSection: string,
): void {
  if (pageFooterEl === null) return;
  const footerHtml = data[pageFooterSection];
  if (footerHtml === undefined) return;
  const parsed = new DOMParser().parseFromString(footerHtml, 'text/html');
  const newContent = parsed.querySelector('.js-contents');
  const liveContent = pageFooterEl.querySelector('.js-contents');
  if (newContent !== null && liveContent !== null) {
    liveContent.innerHTML = newContent.innerHTML;
  }
}

function applyBadgeAndPageFooter(
  data: Record<string, string>,
  badgeSectionId: string,
  pageFooterEl: HTMLElement | null,
  pageFooterSection: string | undefined,
): void {
  const badgeHtml = data[badgeSectionId];
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
  if (pageFooterSection !== undefined && pageFooterSection !== '') {
    applyPageFooter(data, pageFooterEl, pageFooterSection);
  }
}

// FOUC mask: data-fge-pending signals "FGE controls this region". data-fge-grouped lifts it.
// maskCartHost() always strips grouped first so a stale flag cannot skip the CSS hide after a theme
// re-render. ensureUnmasked() is the safety backstop; maskCartHost() only starts a timer when none runs.

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
  // If a reconcile is still in progress, defer the unmask — lifting now would show ungrouped
  // content (including gift lines). Retry after another MASK_TIMEOUT_MS.
  if (running || pending) {
    maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
    return;
  }
  if (lastPlan !== null && lastPlan.lineCount === 0) {
    document.querySelectorAll<HTMLElement>(`[${MASK_ATTR}]`).forEach((el) => {
      el.removeAttribute(MASK_ATTR);
    });
    document
      .querySelectorAll<HTMLElement>('cart-drawer-items, cart-items')
      .forEach((el) => showNativeEmptyCart(el));
    return;
  }
  document.querySelectorAll<HTMLElement>(`[${MASK_ATTR}]`).forEach((el) => {
    el.setAttribute(GROUPED_ATTR, '');
    el.removeAttribute(MASK_ATTR);
  });
  // Fail-safe: lift the body.fge-active hide when grouping did not run (e.g. no campaign).
  document
    .querySelectorAll<HTMLElement>(
      'cart-drawer-items:not([data-fge-grouped]):not([data-fge-empty-native]), cart-items:not([data-fge-grouped]):not([data-fge-empty-native])',
    )
    .forEach((el) => {
      el.setAttribute(GROUPED_ATTR, '');
    });
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
  document.body.classList.add('fge-active');

  // Declared before mountCartContexts so the onReattach closure can read it: when a debounced
  // trigger is pending (timer !== undefined), don't lift the mask — the upcoming reconcile will
  // apply fresh grouping and lift it cleanly.
  let timer: ReturnType<typeof setTimeout> | undefined;

  sections = mountCartContexts({
    drawerSelector: config.drawerSelector,
    onReattach: (_context, itemsEl) => {
      const host = cartHost(itemsEl);

      if (lastPlan !== null && lastPlan.lineCount === 0) {
        showNativeEmptyCart(host);
        return;
      }

      if (host !== null) {
        host.removeAttribute(EMPTY_NATIVE_ATTR);
      }

      if (lastPlan !== null) {
        applyFgeCartDisplay(itemsEl);
      } else if (host !== null) {
        host.removeAttribute(GROUPED_ATTR);
        maskCartHost(host);
      }
    },
  });

  // FOUC mask: dim the line-items region until the first grouping pass or timeout.
  applyInitialMask();
  observeDrawerOpen(); // mask on drawer open (before paint) — catches the PDP add-to-cart case

  const trigger = (data?: unknown): void => {
    // Ignore the echo of our own theme re-render publish.
    if (
      data !== null &&
      typeof data === 'object' &&
      (data as { source?: string }).source === SOURCE
    ) {
      return;
    }
    // Mask immediately (before debounce) so the spinner is visible during theme re-render + reconcile.
    if (cartHasFgeLines()) {
      maskAllCartHosts();
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined; // clear before schedule so onReattach sees "no pending trigger"
      schedule(config);
    }, DEBOUNCE_MS);
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
