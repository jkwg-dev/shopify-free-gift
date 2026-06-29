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
import {
  applyTwoGroupLayout,
  syncNativeInputs,
  type MergedQtyChangeResult,
} from './groupingTransform.js';
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

// Two-group line transform (Stage 1): the latest classification/merge plan + cart currency, recomputed
// after each reconcile from a fresh /cart.js read. The cartSections re-attach hook applies it to each
// surface's line list. Presentation-only — no cart write.
let lastPlan: GroupingPlan | null = null;
// Set by verifiedDisplayReconcile to tell onReattach "this attach carries a fresh plan — apply it
// even though a reconcile is in-flight". Cleared after the attach calls complete.
let freshPlanAttach = false;

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
async function refreshItemsBody(cart: AjaxCart): Promise<boolean> {
  const drawerSectionId = detectDrawerSectionId();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 300 * attempt));
      const res = await fetch(`${root}?sections=${drawerSectionId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, string>;
      const html = data[drawerSectionId];
      if (html === undefined) continue;

      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const ITEMS_SELECTORS = ['cart-drawer-items', '[data-cart-items]', '.cart-drawer__items'];
      for (const sel of ITEMS_SELECTORS) {
        const newItems = parsed.querySelector(sel);
        const liveItems = document.querySelector(sel);
        if (newItems !== null && liveItems !== null) {
          liveItems.innerHTML = newItems.innerHTML;
          // Verify the fetched section matches cart.js.
          if (domMatchesCart(liveItems as HTMLElement, cart)) {
            return true;
          }
          break; // replaced but still mismatched — retry
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
  return false;
}

// Verified display reconcile: compare DOM to cart.js, force a body re-fetch if divergent, then
// apply grouping + stamp. Called on every reconcile (including no-ops) and on every drawer open.
async function verifiedDisplayReconcile(): Promise<void> {
  try {
    const cart = await getCart();
    const itemsEl = document.querySelector<HTMLElement>('cart-drawer-items, cart-items');

    if (!domMatchesCart(itemsEl, cart)) {
      console.warn('[FGE-DRAWERFIX] DOM/cart divergence detected, forcing body refetch', {
        domVariants: domVariantIds(itemsEl),
        cartVariants: cart.items.map((i) => i.variant_id),
      });
      await refreshItemsBody(cart);
      // Re-mount sections so the grouping transform sees the new nodes.
      for (const section of sections) section.attach();
    }

    // Recompute grouping from fresh cart and apply. The freshPlanAttach flag tells onReattach to
    // apply this plan even though a reconcile is in-flight (the plan was just computed from the
    // post-mutation cart, so it's NOT stale).
    lastPlan = classifyAndGroup(toGroupingLines(cart), lastDiscount);
    lastCartQuantities = cart.items.map((item) => item.quantity);
    freshPlanAttach = true;
    for (const section of sections) section.attach();
    freshPlanAttach = false;

    // Dawn inserts newly-added gift nodes asynchronously (its own section re-render after
    // cart/add.js). Schedule a deferred re-apply so the gift node is hidden even if it arrives
    // after this synchronous pass. The plan is already fresh; the re-apply is idempotent.
    setTimeout(() => {
      freshPlanAttach = true;
      for (const section of sections) section.attach();
      freshPlanAttach = false;
    }, 500);

    // Stamp authoritative subtotal + badge.
    const giftQty = cart.items.filter(isGiftLine).reduce((n, item) => n + item.quantity, 0);
    const buyOnlyCount = (cart.item_count ?? 0) - giftQty;
    if (cart.total_price !== undefined && cart.item_count !== undefined) {
      stampAuthoritativeCart({ total_price: cart.total_price, item_count: buyOnlyCount });
    }
  } catch {
    // Best-effort.
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
    finalLinePrice: item.final_line_price ?? 0,
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
    // Section-fetch body refresh: only when the reconcile mutated the cart (the section response can
    // be stale mid-mutation). The cart.js-driven display reconcile below runs unconditionally.
    const cartMutated = outcome.passes > 1 || outcome.appliedCode !== lastPriorCode;
    if (cartMutated) {
      await refreshDawnTotals();
    }
    // Verified display reconcile: compare DOM to cart.js, force a body re-fetch if the node set
    // diverges (stale duplicates, missing buy nodes), then apply grouping + stamp. Runs on EVERY
    // reconcile including no-ops so a stale DOM always converges.
    await verifiedDisplayReconcile();
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

// Re-mask elements that are NOT currently grouped (timeout-lifted or never grouped). Restarts the 2s
// timeout. Elements that ARE grouped (data-fge-grouped present) are NOT re-masked (no flicker).
function remaskUngrouped(): void {
  let any = false;
  document.querySelectorAll<HTMLElement>('cart-drawer-items, cart-items').forEach((el) => {
    if (!el.hasAttribute(GROUPED_ATTR)) {
      el.setAttribute(MASK_ATTR, '');
      any = true;
    }
  });
  if (any && maskTimer === undefined) {
    maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
  }
}

// Observe the cart drawer for OPEN: Dawn adds 'active' class on open (synchronous via setTimeout(0)).
// A MutationObserver on class-attribute fires in the microtask queue — before the browser paints — so
// we mask ungrouped content at the exact moment the drawer becomes visible.
function observeDrawerOpen(): void {
  const drawer = document.querySelector<HTMLElement>(DRAWER_PANEL_SELECTOR);
  if (drawer === null) return;
  new MutationObserver(() => {
    if (drawer.classList.contains('active')) {
      remaskUngrouped();
      // On drawer open, run the verified display reconcile: compare DOM to cart.js, force a body
      // re-fetch if divergent, then apply grouping + stamp. Never shows a frozen prior render.
      void verifiedDisplayReconcile();
    }
  }).observe(drawer, { attributes: true, attributeFilter: ['class'] });
}

function schedule(config: WidgetConfig): void {
  if (running) {
    pending = true;
    return;
  }
  remaskUngrouped();
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

// Detect the Shopify section ID for the cart drawer from the live DOM. Anchored on the ITEMS
// CONTAINER (#CartDrawer-Body, cart-drawer-items) — the node the refetch needs to replace — so it
// returns the section that actually contains cart line items, never a recommendations or trigger
// button section. Falls back to a panel-level detection (excluding buttons/triggers) only if the
// items anchor is not found.
function detectDrawerSectionId(): string {
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
      if (section !== null) return section.id.replace('shopify-section-', '');
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
      // Verify this section actually contains cart items; if not, log and fall back.
      if (section.querySelector('.cart-item, #CartDrawer-Body, cart-drawer-items') !== null) {
        return id;
      }
      console.warn('[FGE-DRAWERFIX] drawer section misdetected ->', id);
    }
    const dataId =
      drawer.closest<HTMLElement>('[data-section-id]')?.dataset['sectionId'] ??
      (drawer as HTMLElement).dataset?.['sectionId'];
    if (dataId !== undefined && dataId !== '') return dataId;
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
async function refreshDawnTotals(): Promise<void> {
  try {
    const drawerSectionId = detectDrawerSectionId();
    const badgeSectionId = detectBadgeSectionId();
    const sectionIds = [drawerSectionId, badgeSectionId];
    const pageFooterEl = document.getElementById('main-cart-footer');
    const pageFooterSection = pageFooterEl?.dataset['id'];
    if (pageFooterSection !== undefined && pageFooterSection !== '') {
      sectionIds.push(pageFooterSection);
    }
    const [sectionsRes, cart] = await Promise.all([
      fetch(`${root}?sections=${sectionIds.join(',')}`, {
        headers: { Accept: 'application/json' },
      }),
      getCart(),
    ]);
    if (!sectionsRes.ok) return;
    const data = (await sectionsRes.json()) as Record<string, string>;

    const drawerHtml = data[drawerSectionId];

    // Badge: replace the cart-icon-bubble content.
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

    // Defense in depth: stamp authoritative cart.js values into the subtotal and badge so the
    // displayed numbers are never wrong, even if the section HTML is momentarily stale.
    const footerTargetReplaced = drawerHtml !== undefined ? replaceDrawerFooter(drawerHtml) : false;
    // Badge count excludes gift lines — the shopper sees only their purchase count.
    const giftQty = cart.items.filter(isGiftLine).reduce((n, item) => n + item.quantity, 0);
    const buyOnlyCount = (cart.item_count ?? 0) - giftQty;
    let stampResult = { subtotalTargetsFound: 0, badgeTargetsFound: 0 };
    if (cart.total_price !== undefined && cart.item_count !== undefined) {
      stampResult = stampAuthoritativeCart({
        total_price: cart.total_price,
        item_count: buyOnlyCount,
      });
    }

    // Diagnostic: log selector hits + the count-match invariant for dev verification.
    const itemsEl = document.querySelector<HTMLElement>('cart-drawer-items, cart-items');
    const renderedLineNodes = itemsEl
      ? itemsEl.querySelectorAll(
          '.cart-item, [id^="CartDrawer-Item-"], [id^="CartItem-"], cart-item, .cart__row',
        ).length
      : 0;
    console.warn('[FGE-DRAWERFIX]', {
      renderedLineNodes,
      cartItemsLen: cart.items.length,
      realSubtotal: cart.total_price,
      realBadge: cart.item_count,
      displayedBadge: buyOnlyCount,
      footerTargetReplaced,
      subtotalTargetsFound: stampResult.subtotalTargetsFound,
      badgeTargetsFound: stampResult.badgeTargetsFound,
    });
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
  // The section swap wipes our line transforms (hidden gifts, steppers); explicitly re-attach so the
  // chooser is re-mounted and applyTwoGroupLayout re-hides gift lines + re-injects steppers.
  for (const section of sections) section.attach();
  schedule(perceptionConfig);
  if (!result.applied) return fail;
  return {
    applied: true,
    qty: row?.controllableQuantity ?? 0,
    finalPrice: row?.controllableFinalPrice ?? 0,
    originalPrice: row?.controllableOriginalPrice ?? 0,
  };
}

// FOUC mask: data-fge-pending signals "FGE controls this region". data-fge-grouped lifts it.
// onReattach always lifts (grouped or ungrouped) so the mask is never permanent. remask() starts a
// safety timer as a backstop; remaskUngrouped() only starts a timer when none is running.
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
  // If a reconcile is still in progress, defer the unmask — lifting now would show ungrouped
  // content (including gift lines). Retry after another MASK_TIMEOUT_MS.
  if (running || pending) {
    maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
    return;
  }
  document.querySelectorAll<HTMLElement>(`[${MASK_ATTR}]`).forEach((el) => {
    el.setAttribute(GROUPED_ATTR, '');
    el.removeAttribute(MASK_ATTR);
  });
  // Also lift the body.fge-active mask on any cart-drawer-items without data-fge-grouped (the
  // reconcile finished but grouping didn't run — e.g. empty cart or no campaign).
  document
    .querySelectorAll<HTMLElement>(
      'cart-drawer-items:not([data-fge-grouped]), cart-items:not([data-fge-grouped])',
    )
    .forEach((el) => {
      el.setAttribute(GROUPED_ATTR, '');
    });
}

function remask(itemsEl: HTMLElement | null): void {
  const host = itemsEl?.closest<HTMLElement>('cart-drawer-items, cart-items') ?? itemsEl;
  if (host !== null) {
    host.setAttribute(MASK_ATTR, '');
    host.removeAttribute(GROUPED_ATTR);
    if (maskTimer === undefined) {
      maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
    }
  }
}

function liftMask(itemsEl: HTMLElement | null): void {
  const host = itemsEl?.closest<HTMLElement>('cart-drawer-items, cart-items') ?? itemsEl;
  if (host !== null && host.hasAttribute(MASK_ATTR)) {
    host.setAttribute(GROUPED_ATTR, '');
    host.removeAttribute(MASK_ATTR);
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
      remask(itemsEl);
      // Don't apply a stale plan while a reconcile is running, queued, or about to start (debounce
      // timer pending) — UNLESS freshPlanAttach is set, meaning verifiedDisplayReconcile just
      // computed a fresh plan from the post-mutation cart and is calling attach() itself.
      const workPending = (running || pending || timer !== undefined) && !freshPlanAttach;
      if (lastPlan === null || workPending) {
        if (!workPending) liftMask(itemsEl);
        syncNativeInputs(itemsEl, lastCartQuantities);
        return;
      }
      if (
        !applyTwoGroupLayout(itemsEl, lastPlan, {
          onMergedQtyChange: onMergedBuyQtyChange,
        })
      ) {
        liftMask(itemsEl);
      }
      syncNativeInputs(itemsEl, lastCartQuantities);
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
