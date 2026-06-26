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
import { failedAddVariantIds } from './cartMutations.js';
import { defaultGiftChoices } from './choices.js';
import { renderChooser } from './chooser.js';
import { getConfig } from './configClient.js';
import { PENDING_DELAY_MS, PENDING_MAX_MS, pendingHint, setCheckoutLocked } from './pending.js';
import { buildProgressModel, renderProgress } from './progressGraph.js';
import { reconcileGiftCart } from './reconcileLoop.js';
import { injectStyles } from './styles.js';
import { postValidate } from './validateClient.js';

const SOURCE = 'free-gift-engine';
const CART_UPDATE_EVENT = 'cart-update'; // Dawn PUB_SUB_EVENTS.cartUpdate
const DEBOUNCE_MS = 300;

type ThemeWindow = Window & {
  readonly Shopify?: { readonly routes?: { readonly root?: string } };
  readonly subscribe?: (event: string, cb: (data?: unknown) => void) => () => void;
  readonly publish?: (event: string, data?: unknown) => void;
};

type AjaxCartItem = {
  readonly key: string;
  readonly variant_id: number;
  readonly quantity: number;
  readonly properties: Readonly<Record<string, unknown>> | null;
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

// Pending-indicator state (5b-2b): masks the residual gift-reconcile latency. `giftPendingActive` is
// shown only once the in-progress work outlasts PENDING_DELAY_MS (anti-flicker), and is ALWAYS cleared
// on a terminal outcome or the safety timeout (so Checkout never gets stuck). `perceptionConfig` lets
// the timer callbacks re-render without threading config through them.
let giftPendingActive = false;
let giftPendingEngageTimer: ReturnType<typeof setTimeout> | undefined;
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
  try {
    const outcome = await reconcileGiftCart(
      {
        readCart: readCartLines,
        // Server-authoritative: every line carries its app-added claim; the server EXCLUDES app-added
        // gift lines from the qualifying subtotal. Choices + decline are chooser-driven (same wire shape).
        validate: async (lines, currency) => {
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
        // Real gift work is starting → maybe show the pending indicator (gated by the flicker delay).
        onGiftMutationStart: () => beginGiftPending(),
      },
      { initialCode: lastDiscount },
    );
    lastDiscount = outcome.appliedCode;
    // Runtime 422 fallback: any gift that failed to add is marked unavailable so the chooser disables
    // it (+ note) and never shows it as added. Then re-render the perception UI from server state.
    for (const variantId of failedAddVariantIds(outcome.failures)) {
      unavailableVariantIds.add(variantId);
    }
    endGiftPending(); // gift confirmed (or terminal) → clear pending BEFORE the final render
    renderPerception(config);
  } finally {
    endGiftPending(); // safety: also clear on error/throw — Checkout must never stay locked
    selfMutating = false;
  }
}

// Engage the pending indicator only if the in-progress work outlasts the flicker threshold. Called
// when a reconcile is about to do real gift work (onGiftMutationStart); the engage timer is cancelled
// by endGiftPending if the work finishes first, so fast reconciles show nothing.
function beginGiftPending(): void {
  if (giftPendingActive || giftPendingEngageTimer !== undefined) {
    return;
  }
  giftPendingEngageTimer = setTimeout(() => {
    giftPendingEngageTimer = undefined;
    giftPendingActive = true;
    setCheckoutLocked(true);
    if (perceptionConfig !== null) {
      renderPerception(perceptionConfig); // dim chooser + show the hint
    }
  }, PENDING_DELAY_MS);
  giftPendingSafetyTimer = setTimeout(() => endGiftPending(), PENDING_MAX_MS);
}

// Clear pending on EVERY terminal outcome (success, removal, error/422) and on the safety timeout, so
// Checkout is never left stuck. Idempotent.
function endGiftPending(): void {
  if (giftPendingEngageTimer !== undefined) {
    clearTimeout(giftPendingEngageTimer);
    giftPendingEngageTimer = undefined;
  }
  if (giftPendingSafetyTimer !== undefined) {
    clearTimeout(giftPendingSafetyTimer);
    giftPendingSafetyTimer = undefined;
  }
  if (giftPendingActive) {
    giftPendingActive = false;
    setCheckoutLocked(false);
    if (perceptionConfig !== null) {
      renderPerception(perceptionConfig); // restore full opacity + drop the hint
    }
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
  const pending = giftPendingActive
    ? { active: true, message: pendingHint(lastResult !== null) }
    : undefined;
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
      pending,
    );
    section.attach(); // ensure both sections are in the cart flow after rendering
  }
}

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
      }
    });
}

// Inject the two perception sections into EVERY present cart surface (drawer + full /cart page): a
// stepper under the heading, the chooser by the items, re-attached on every re-render. Fetch the
// campaign structure and render. Best-effort: if config is unavailable/inactive, the engine still
// reconciles (AND tiers need no choice). The free gift renders normally in the cart list at $0 — we no
// longer hide it (role separation: the cart line confirms receipt, our chooser is progress + choice).
async function initPerception(config: WidgetConfig): Promise<void> {
  injectStyles(); // design tokens + component CSS (once)
  // Blended, in-flow sections per context (drawer and/or /cart page); re-attached on every re-render.
  sections = mountCartContexts({ drawerSelector: config.drawerSelector });

  const result = await getConfig({
    presentmentCurrency: config.presentmentCurrency,
    countryCode: config.country,
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
