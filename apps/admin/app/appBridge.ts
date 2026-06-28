// Thin client-side wrapper over the App Bridge global (window.shopify, from the CDN app-bridge.js
// loaded in layout.tsx). Centralizes the session-token fetch, the variant resource picker, and the
// authenticated fetch so every embedded screen uses one helper — and so the Window augmentation is
// declared exactly ONCE (declaring it per-component would clash). Runs client-side only.

// We pick gifts with the PRODUCT resource picker (filter.variants: true), NOT the variant picker: the
// variant picker renders rows with only the variant title/price (blank or "$10" for single-variant
// "Default Title" products), so the merchant can't tell which product a row is. The product picker
// shows product-name rows and returns each selected product with its selected variants, which we
// flatten to per-variant GIDs (flattenPickedVariantIds). Display labels are still resolved server-side
// (resolveVariantLabels) so picker-added and edit-loaded labels match.
import { flattenPickedVariantIds, type PickedProduct } from '../src/admin/pickedVariants.js';

type ResourcePickerOptions = {
  readonly type: 'product' | 'variant' | 'collection';
  readonly multiple?: boolean | number;
  readonly action?: 'add' | 'select';
  readonly filter?: { readonly variants?: boolean };
};

type AppBridge = {
  readonly idToken: () => Promise<string>;
  readonly resourcePicker: (
    options: ResourcePickerOptions,
  ) => Promise<readonly PickedProduct[] | undefined>;
};

declare global {
  interface Window {
    shopify?: AppBridge;
  }
}

function bridge(): AppBridge {
  const b = window.shopify;
  if (b === undefined) {
    throw new Error('App Bridge unavailable — open this app from your Shopify admin.');
  }
  return b;
}

// Open the PRODUCT resource picker with variant selection on; returns the picked variant GIDs (the
// selected variants across the chosen products, de-duplicated; [] if cancelled).
export async function pickVariantIds(): Promise<string[]> {
  const selected = await bridge().resourcePicker({
    type: 'product',
    filter: { variants: true },
    multiple: true,
    action: 'select',
  });
  return selected === undefined ? [] : flattenPickedVariantIds(selected);
}

// fetch() with the App Bridge session token attached as a Bearer header (the embedded admin's JWT
// boundary). Does NOT throw — the caller inspects the Response (used by flows that must read a
// non-2xx body, e.g. the 409 confirm-and-replace signal).
export async function authedFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await bridge().idToken();
  return fetch(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

// authedFetchRaw + throw on a non-2xx response, surfacing the ApiError message when present. For the
// common "succeed or show the error" flows (list, deactivate).
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await authedFetchRaw(path, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.clone().json()) as { error?: { message?: string } };
      if (body.error?.message !== undefined) {
        message = body.error.message;
      }
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(message);
  }
  return res;
}

// Resolve gift variant GIDs to their display labels ("Product — Variant", or just "Product" for a
// single-variant product) via the JWT-authed admin endpoint. Authoritative + consistent with the
// edit view; falls back to the GID for any id the server couldn't resolve.
export async function resolveVariantLabels(
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) {
    return {};
  }
  const res = await authedFetch('/api/admin/variant-labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantIds: ids }),
  });
  const data = (await res.json()) as { labels: Record<string, string> };
  return data.labels;
}
