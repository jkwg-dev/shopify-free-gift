// Pending indicator for the residual gift-reconcile latency (Phase 5b-2b). After steps 1-3a the
// STEPPER is fast + authoritative, but the gift may not be visibly in the cart at $0 for up to ~1.5s
// while it is added / swapped / re-added and its code applied. We mask that window as intentional UX:
// a small "Updating…" hint + a dimmed chooser + a temporarily-locked Checkout button — engaged ONLY if
// the work outlasts a flicker threshold, and ALWAYS cleared on every terminal outcome (plus a safety
// timeout) so Checkout can never get stuck. Authoritative: pending only means "work in progress"; the
// real gift/price always comes from the confirmed cart/validate, never a fake.

export const PENDING_DELAY_MS = 350; // don't engage for fast reconciles (anti-flicker)
export const PENDING_MAX_MS = 8000; // safety: never trap the shopper from paying

// Chooser hint copy. First load (no confirmed /validate result yet) reads "Loading…"; an update to an
// already-known state reads "Updating…". Pure + unit-tested.
export function pendingHint(hasConfirmedResult: boolean): string {
  return hasConfirmedResult ? 'Updating your free gift…' : 'Loading your free gift…';
}

// Theme Checkout buttons (drawer + /cart), resilient across Dawn-like themes.
const CHECKOUT_SELECTORS = [
  '#CartDrawer-Checkout',
  '#checkout',
  'button[name="checkout"]',
  '[name="checkout"]',
  '.cart__checkout-button',
];
const CHECKOUT_LOCK_CLASS = 'fge-checkout-pending';

// Lock/unlock Checkout while a gift reconcile is in progress, covering BOTH the drawer and /cart.
// The body class is the DURABLE lock (CSS pointer-events:none + dim) — it survives the theme
// re-rendering its footer; setting disabled/aria-disabled on the found buttons is a best-effort
// keyboard block. Degrades safely: if no Checkout button exists (other theme) the body class is a
// harmless no-op. Never throws. The realistic bypass (a keyboard activation between footer re-renders)
// is non-critical — it can only mean "no gift yet", never a wrong charge or a leak.
export function setCheckoutLocked(locked: boolean): void {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    return;
  }
  doc.body?.classList.toggle(CHECKOUT_LOCK_CLASS, locked);
  for (const el of Array.from(doc.querySelectorAll(CHECKOUT_SELECTORS.join(', ')))) {
    if (locked) {
      el.setAttribute('aria-disabled', 'true');
      (el as { disabled?: boolean }).disabled = true;
    } else {
      el.removeAttribute('aria-disabled');
      (el as { disabled?: boolean }).disabled = false;
    }
  }
}
