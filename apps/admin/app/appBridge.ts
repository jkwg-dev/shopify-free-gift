// Thin client-side wrapper over the App Bridge global (window.shopify, from the CDN app-bridge.js
// loaded in layout.tsx). Centralizes the session-token fetch, the variant resource picker, and the
// authenticated fetch so every embedded screen uses one helper — and so the Window augmentation is
// declared exactly ONCE (declaring it per-component would clash). Runs client-side only.

// The resource-picker variant payload only guarantees the GID; its label fields are inconsistent
// (e.g. blank/"Default Title" for single-variant products), so we read just `id` and resolve the
// display label server-side (resolveVariantLabels) — the same fetchVariantMeta path the edit view
// uses, so picker-added and edit-loaded labels always match.
type PickedResource = { readonly id: string };

type ResourcePickerOptions = {
  readonly type: 'product' | 'variant' | 'collection';
  readonly multiple?: boolean | number;
  readonly action?: 'add' | 'select';
};

type AppBridge = {
  readonly idToken: () => Promise<string>;
  readonly resourcePicker: (
    options: ResourcePickerOptions,
  ) => Promise<readonly PickedResource[] | undefined>;
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

// Open the variant resource picker; returns the picked variant GIDs ([] if cancelled).
export async function pickVariantIds(): Promise<string[]> {
  const selected = await bridge().resourcePicker({
    type: 'variant',
    multiple: true,
    action: 'select',
  });
  return selected === undefined ? [] : selected.map((r) => r.id);
}

// fetch() with the App Bridge session token attached as a Bearer header (the embedded admin's JWT
// boundary). Throws on a non-2xx response, surfacing the ApiError message when present.
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await bridge().idToken();
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
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
