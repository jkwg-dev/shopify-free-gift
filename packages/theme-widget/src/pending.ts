// Pending indicator for the residual gift-reconcile latency (Phase 5b-2b). After steps 1-3a the
// STEPPER is fast + authoritative, but the gift may not be visibly in the cart at $0 for up to ~1.5s
// while it is added / swapped / re-added and its code applied. We mask that window as intentional UX:
// a spinner by the chooser heading, the chooser cards dimmed, and the theme Checkout button dimmed +
// locked + showing a spinner + "Updating…". Engaged immediately and held a beat, and ALWAYS cleared on
// every terminal outcome (plus a safety timeout) so Checkout can never get stuck. We deliberately do
// NOT touch the cart line items — the theme re-renders that list on its own schedule, so dimming gift
// rows there lagged/flickered out of sync; the list just shows the current state. Authoritative:
// pending only means "work in progress"; the real gift/price always comes from the confirmed cart.

export const PENDING_MIN_MS = 500; // engage immediately, then HOLD at least this long (anti-flicker)
export const PENDING_MAX_MS = 8000; // safety: never trap the shopper from paying

// Pure: pending clears only once the work is done AND the minimum visible duration has elapsed — i.e.
// at max(work-done, min-duration). Engaging immediately + holding a beat replaces "delay then show".
export function pendingShouldClear(workDone: boolean, minElapsed: boolean): boolean {
  return workDone && minElapsed;
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
const LIVE_REGION_ID = 'fge-live';

// Announce the pending state to assistive tech (the Checkout overlay text is CSS ::after content, which
// screen readers don't reliably read). A single persistent visually-hidden polite live region: set a
// message on engage so an AT user learns WHY Checkout is disabled, clear it ('') when done. A <span>
// (not a div) dodges the theme's div:empty{display:none}. Never throws.
export function announcePending(message: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    return;
  }
  let live = doc.getElementById(LIVE_REGION_ID);
  if (live === null) {
    live = doc.createElement('span');
    live.id = LIVE_REGION_ID;
    live.className = 'fge-sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    doc.body?.append(live);
  }
  live.textContent = message;
}

// Lock/unlock Checkout while a gift reconcile is in progress, covering BOTH the drawer and /cart. The
// body class is the DURABLE lock + spinner/label overlay (all CSS — see styles.ts), so it survives the
// theme re-rendering its footer AND restores the original "Check out" label exactly when removed (no
// innerHTML save/restore to get wrong). Setting disabled/aria-disabled is a best-effort keyboard block.
// Degrades safely: no Checkout button -> the body class is a harmless no-op. Never throws.
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
