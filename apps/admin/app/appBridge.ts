// Thin client-side wrapper over the App Bridge global (window.shopify, from the CDN app-bridge.js
// loaded in layout.tsx). Centralizes the session-token fetch, the variant resource picker, and the
// authenticated fetch so every embedded screen uses one helper — and so the Window augmentation is
// declared exactly ONCE (declaring it per-component would clash). Runs client-side only.

// The subset of the resource-picker result we read. A picked variant carries its GID and a label
// (displayName is "Product - Variant"); other fields are ignored.
type PickedResource = {
  readonly id: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly product?: { readonly title?: string };
};

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

export type PickedVariant = { readonly variantId: string; readonly title: string };

function bridge(): AppBridge {
  const b = window.shopify;
  if (b === undefined) {
    throw new Error('App Bridge unavailable — open this app from your Shopify admin.');
  }
  return b;
}

function variantLabel(r: PickedResource): string {
  if (r.displayName !== undefined && r.displayName.length > 0) {
    return r.displayName;
  }
  if (r.product?.title !== undefined && r.title !== undefined) {
    return `${r.product.title} – ${r.title}`;
  }
  return r.title ?? r.id;
}

// Open the variant resource picker; returns the picked variants ([] if cancelled).
export async function pickVariants(): Promise<PickedVariant[]> {
  const selected = await bridge().resourcePicker({
    type: 'variant',
    multiple: true,
    action: 'select',
  });
  if (selected === undefined) {
    return [];
  }
  return selected.map((r) => ({ variantId: r.id, title: variantLabel(r) }));
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
