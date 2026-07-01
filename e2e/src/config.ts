// Central E2E configuration. The target is a LIVE Shopify PREVIEW theme (the FGE app embed is enabled
// on the preview theme, NOT on the published one), so every run drives a real browser through the real
// storefront + real App Proxy (/apps/free-gift/config + /validate). Overridable via env so the same
// suite can point at a different store/theme without code edits.

export const STORE_ORIGIN = process.env['FGE_STORE_ORIGIN'] ?? 'https://shop.greenteegolfshop.com';

// Unpublished preview theme id. The share params (_ab/_fd/_sc) + preview_theme_id set the preview
// session cookie on first navigation; the theme then sticks for the rest of the browser session.
export const PREVIEW_THEME_ID = process.env['FGE_PREVIEW_THEME_ID'] ?? '155184791742';

export const PREVIEW_QUERY = `_ab=0&_fd=0&_sc=1&preview_theme_id=${PREVIEW_THEME_ID}`;

// LIVE mode: target the PUBLISHED theme directly (no preview_theme_id) — used once the app embed is
// enabled on the live theme. Opt in with FGE_LIVE=1 to reproduce exactly what shoppers see.
export const LIVE = process.env['FGE_LIVE'] === '1';

// Market the preview session runs in (matches the store's base market so products.json prices ==
// the presentment prices /validate computes, keeping the cart-building math exact).
export const COUNTRY = process.env['FGE_COUNTRY'] ?? 'CA';
export const CURRENCY = process.env['FGE_CURRENCY'] ?? 'CAD';

// Default HEADFUL: a real (non-headless) Chrome carries a genuine UA + fingerprint, which the live
// store's bot detection does NOT throttle (manual browsing is fine). Opt into headless with
// FGE_HEADLESS=1 (then we also spoof the UA + mask automation flags — see browser.ts).
export const HEADLESS = process.env['FGE_HEADLESS'] === '1';

// Only run a subset when FGE_ONLY is set (comma-separated scenario ids), useful while iterating.
export const ONLY = (process.env['FGE_ONLY'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// Generous timeouts: this hits a real store over the network, and /validate mints/looks up discount
// codes in Postgres on the reconcile path.
export const NAV_TIMEOUT_MS = 45_000;
export const RECONCILE_TIMEOUT_MS = 30_000;

export function previewUrl(path = '/'): string {
  if (LIVE) return `${STORE_ORIGIN}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${STORE_ORIGIN}${path}${sep}${PREVIEW_QUERY}`;
}
