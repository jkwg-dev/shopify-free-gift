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
import {
  mountDrawerOverlay,
  hideGiftLineRows,
  giftRowTargets,
  type DrawerMount,
} from './cartDrawer.js';
import { failedAddVariantIds } from './cartMutations.js';
import { defaultGiftChoices } from './choices.js';
import { renderChooser } from './chooser.js';
import { getConfig } from './configClient.js';
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
  // Optional per-theme overrides for portability (production theme ≠ dev snowboard theme).
  readonly drawerSelector?: string | undefined;
  readonly drawerOpenClass?: string | undefined;
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
    drawerOpenClass: el.dataset['drawerOpenClass'],
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
let drawer: DrawerMount | null = null;
let graphEl: HTMLElement | null = null;
let chooserEl: HTMLElement | null = null;

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
  } finally {
    selfMutating = false;
  }
}

// Render the progress graph + chooser into the drawer overlay from CURRENT server-confirmed state.
function renderPerception(config: WidgetConfig): void {
  if (campaignConfig === null || graphEl === null || chooserEl === null) {
    return;
  }
  // The CURRENT (highest reached) tier is the gift the shopper receives — the chooser shows ONLY it.
  const currentTierId = lastResult?.status === 'gift' ? lastResult.tierId : null;
  renderProgress(graphEl, buildProgressModel(campaignConfig, lastResult));
  renderChooser(
    chooserEl,
    campaignConfig,
    { choices: choiceState, declined, unavailableVariantIds },
    {
      onChoose: (tierId, optionId) => {
        choiceState = { ...choiceState, [tierId]: optionId };
        renderPerception(config); // reflect the selection immediately
        schedule(config); // transactional re-validate/reconcile for the new choice
      },
      onDeclineToggle: (next) => {
        declined = next;
        renderPerception(config);
        schedule(config);
      },
    },
    currentTierId,
  );
  drawer?.refresh();
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

// Hide the app-added gift line(s) from the drawer's product list so the gift shows ONLY in our panel.
// VISUAL ONLY — the gift line stays in the cart (it carries the BXGY code → $0 and must ship). Re-reads
// the live cart to know WHICH lines are gifts (the _fge_gift property isn't in the rendered markup),
// then hides those rows precisely (cartDrawer falls back to NOT hiding if it can't identify them).
async function hideGiftLinesInDrawer(): Promise<void> {
  if (drawer?.drawerEl == null) {
    return;
  }
  const cart = await getCart();
  hideGiftLineRows(drawer.drawerEl, giftRowTargets(cart.items));
}

// Mount the drawer overlay (graph + chooser), fetch the campaign structure, and render. Best-effort:
// if config is unavailable/inactive, the engine still reconciles (AND tiers need no choice).
async function initPerception(config: WidgetConfig): Promise<void> {
  injectStyles(); // design tokens + component CSS (once)
  // Overlay lives on document.body so it SURVIVES the drawer's inner re-render on every cart change,
  // and sits above the backdrop (clickable). Shown/hidden with the drawer (resilient + overridable).
  drawer = mountDrawerOverlay({
    drawerSelector: config.drawerSelector,
    openClass: config.drawerOpenClass,
    onRender: () => void hideGiftLinesInDrawer(),
  });
  graphEl = document.createElement('div');
  chooserEl = document.createElement('div');
  drawer.container.append(graphEl, chooserEl);

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
