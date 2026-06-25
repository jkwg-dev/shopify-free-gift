import { isValidShopDomain } from '../auth/oauth.js';

// Pure branching for the app entry point GET "/". Shopify opens the app at the App URL ("/") with a
// `shop` query param (and `host` when embedded). This decides what "/" does; the route handler is a
// thin adapter that maps the result to a Response. Kept here (not in app/) so it is unit-testable.
//
// The fix this enables: an install-link / app-open for a not-yet-installed shop must enter OAuth
// begin instead of dead-ending.

export type RootEntryResult =
  | { readonly kind: 'redirect'; readonly location: string } // -> 302 (start OAuth)
  | { readonly kind: 'ok'; readonly body: string } // -> 200
  | { readonly kind: 'bad-request'; readonly body: string }; // -> 400

export type RootEntryDeps = {
  // True iff a usable offline token exists for the shop. MUST NOT throw — return false on any
  // doubt, so we redirect to begin (begin is safe for an already-installed shop; missing a
  // not-installed redirect is the bug we are fixing).
  readonly isInstalled: (shop: string) => Promise<boolean>;
};

export async function resolveRootEntry(
  shop: string | null,
  deps: RootEntryDeps,
): Promise<RootEntryResult> {
  if (shop === null || shop.length === 0) {
    return {
      kind: 'ok',
      body: 'Free Gift Engine. Open this app from your Shopify admin or the install link.',
    };
  }
  // Validate before using `shop` in a redirect (open-redirect guard).
  if (!isValidShopDomain(shop)) {
    return { kind: 'bad-request', body: 'Invalid shop parameter.' };
  }
  const installed = await deps.isInstalled(shop);
  if (!installed) {
    return { kind: 'redirect', location: `/api/auth?shop=${encodeURIComponent(shop)}` };
  }
  // Installed: minimal placeholder for now. The embedded admin UI is Phase 3b and, when it lands
  // at "/", must sit behind the App Bridge session-token flow for installed shops (the
  // not-installed -> begin redirect stays).
  return { kind: 'ok', body: 'Free Gift Engine installed.' };
}
