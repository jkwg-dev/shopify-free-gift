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
  reconcileGiftLines,
  type CampaignConfigResponse,
  type CartLineView,
  type ValidateRequest,
} from '@free-gift-engine/core';
import { defaultGiftChoices } from './choices.js';
import { renderChooser } from './chooser.js';
import { getConfig } from './configClient.js';
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
};

const w = window as ThemeWindow;
const root = w.Shopify?.routes?.root ?? '/';

const toGid = (variantId: number): string => `gid://shopify/ProductVariant/${variantId}`;
const toNumericId = (gid: string): number => Number(gid.split('/').pop());
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

async function postJson(path: string, body: unknown): Promise<void> {
  await fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

async function reconcileOnce(config: WidgetConfig): Promise<void> {
  const cart = await getCart();

  // Server-authoritative: send every line with its app-added claim; the server EXCLUDES app-added
  // gift lines from the qualifying subtotal (so a gift never inflates the tier). Choices + decline
  // come from the chooser state — the existing ValidateRequest shape, only a different source.
  const request: ValidateRequest = {
    cart: cart.items.map((item) => ({
      variantId: toGid(item.variant_id),
      quantity: item.quantity,
      appAdded: isGiftLine(item),
    })),
    choices: choiceState,
    declined,
    presentmentCurrency: cart.currency,
    countryCode: config.country,
  };

  const response = await postValidate(request, { proxyPath: config.proxyPath });
  if (!response.ok) {
    // Surface nothing here (no error UI in 5b-2a); leave the cart untouched on error.
    return;
  }

  const lines: CartLineView[] = cart.items.map((item) => ({
    id: item.key,
    variantId: toGid(item.variant_id),
    quantity: item.quantity,
    appAdded: isGiftLine(item),
  }));
  const plan = reconcileGiftLines(lines, response.result);

  const hasCartMutations = plan.add.length > 0 || plan.remove.length > 0;
  const discountChanged = plan.applyCode !== lastDiscount;
  if (!hasCartMutations && !discountChanged) {
    return; // already reconciled — no flicker, no redundant writes
  }

  selfMutating = true;
  try {
    // Remove stale app-added gift lines first (quantity 0 by line key), then add the resolved gifts.
    for (const removal of plan.remove) {
      await postJson('cart/change.js', { id: removal.id, quantity: 0 });
    }
    for (const addition of plan.add) {
      await postJson('cart/add.js', {
        items: [
          {
            id: toNumericId(addition.variantId),
            quantity: addition.quantity,
            properties: addition.properties,
          },
        ],
      });
    }
    // Apply or clear the discount via the Cart AJAX API (empty string clears).
    if (discountChanged) {
      await postJson('cart/update.js', { discount: plan.applyCode ?? '' });
      lastDiscount = plan.applyCode;
    }
  } finally {
    selfMutating = false;
  }

  // Ask the theme to re-render its cart UI (drawer/sections) so the gift line appears. Tagged with
  // our source so we ignore the echo. (Drawer-render polish is 5b-2b.)
  w.publish?.(CART_UPDATE_EVENT, { source: SOURCE });
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

// Fetch the campaign structure and render the chooser. Best-effort: if config is unavailable or the
// campaign is inactive, the engine still reconciles (AND tiers need no choice); OR tiers simply have
// no selection until config loads.
async function initChooser(config: WidgetConfig): Promise<void> {
  const result = await getConfig({
    presentmentCurrency: config.presentmentCurrency,
    countryCode: config.country,
  });
  if (!result.ok || result.config.status !== 'active') {
    return;
  }
  const campaignConfig: CampaignConfigResponse = result.config;
  choiceState = defaultGiftChoices(campaignConfig.tiers);

  const mount = document.querySelector<HTMLElement>('[data-fge-chooser]');
  if (mount === null) {
    return;
  }
  renderChooser(
    mount,
    campaignConfig,
    { choices: choiceState, declined },
    {
      onChoose: (tierId, optionId) => {
        choiceState = { ...choiceState, [tierId]: optionId };
        schedule(config);
      },
      onDeclineToggle: (next) => {
        declined = next;
        schedule(config);
      },
    },
  );
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

  // Load the chooser (default selection enables the gift), then the initial reconcile.
  void initChooser(config).finally(() => schedule(config));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
