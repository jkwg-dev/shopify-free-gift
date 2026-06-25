// Phase 5b-1 storefront controller: wires the PURE reconciler (5a) to the real (Dawn-derived) theme
// cart. On every cart change it reads the cart, calls /validate, and applies reconcileGiftLines'
// mutations (add/remove gift lines + apply/clear the discount code). Minimal UI — the progress
// widget, OR/variant chooser, and decline checkbox are Phase 5b-2.
//
// Bundled to assets/free-gift.js by build.mjs (esbuild). Never sets prices (the minted code +
// Shopify discount do) and never trusts client state for eligibility (the server recomputes).
import {
  GIFT_LINE_PROPERTY,
  reconcileGiftLines,
  type CartLineView,
  type ValidateRequest,
} from '@free-gift-engine/core';
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
  readonly choices: Readonly<Record<string, string>>;
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
  let choices: Record<string, string> = {};
  const raw = el.dataset['defaultChoices'];
  if (raw !== undefined && raw.trim().length > 0) {
    try {
      choices = JSON.parse(raw) as Record<string, string>;
    } catch {
      choices = {};
    }
  }
  return {
    proxyPath: el.dataset['proxyPath'] ?? '/apps/free-gift/validate',
    country: el.dataset['country'] ?? '',
    choices,
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
  // gift lines from the qualifying subtotal (so a gift never inflates the tier).
  const request: ValidateRequest = {
    cart: cart.items.map((item) => ({
      variantId: toGid(item.variant_id),
      quantity: item.quantity,
      appAdded: isGiftLine(item),
    })),
    choices: config.choices,
    declined: false, // decline UI is 5b-2
    presentmentCurrency: cart.currency,
    countryCode: config.country,
  };

  const response = await postValidate(request, { proxyPath: config.proxyPath });
  if (!response.ok) {
    // Surface nothing in 5b-1 (no UI); leave the cart untouched on error.
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

  // Ask the theme to re-render its cart UI (drawer/sections). 5b-2 owns the perception UX; here we
  // just nudge the theme so the gift line appears. Tagged with our source so we ignore the echo.
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

  // Initial reconcile (cart may already qualify on load).
  schedule(config);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
