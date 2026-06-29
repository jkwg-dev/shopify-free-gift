// A minimal, theme-agnostic transient NOTICE for surfacing a cart-write failure to the shopper (defect
// B.1): a single fixed-position toast appended to <body>, also an aria-live region so assistive tech
// announces it. Self-contained — no theme markup dependency, idempotent (one shared element, reused).
// Display-only: the message text is whatever the caller passes (parsed from the response body upstream);
// no logic depends on it.

const NOTICE_ID = 'fge-notice';
const VISIBLE_MS = 6000;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

// Show (or replace) the notice with `message`. Empty/blank message is a no-op. Auto-clears after a few
// seconds; a new message resets the timer.
export function showNotice(message: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined || message.trim() === '') {
    return;
  }
  let el = doc.getElementById(NOTICE_ID);
  if (el === null) {
    el = doc.createElement('div');
    el.id = NOTICE_ID;
    el.className = 'fge fge-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'assertive');
    doc.body.append(el);
  }
  el.textContent = message;
  el.classList.add('is-visible');
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
  }
  hideTimer = setTimeout(() => {
    el?.classList.remove('is-visible');
    hideTimer = undefined;
  }, VISIBLE_MS);
}
