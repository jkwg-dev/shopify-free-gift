// Pending indicator for the residual gift-reconcile latency (Phase 5b-2b). After steps 1-3a the
// STEPPER is fast + authoritative, but the gift may not be visibly in the cart at $0 for up to ~1.5s
// while it is added / swapped / re-added and its code applied. We mask that window as intentional UX:
// a spinner by the chooser heading, the chooser cards AND the in-cart gift line(s) dimmed, and the
// theme Checkout button dimmed + locked + showing a spinner + "Updating…". Engaged ONLY if the work
// outlasts a flicker threshold, and ALWAYS cleared on every terminal outcome (plus a safety timeout)
// so Checkout can never get stuck. Authoritative: pending only means "work in progress"; the real
// gift/price always comes from the confirmed cart/validate, never a fake.

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
const ROW_DIM_CLASS = 'fge-gift-row-dim';

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

// Pure: of the WANTED gift variant ids, which can we CONFIDENTLY map to a single cart row? A variant
// that appears on exactly one row is unambiguous; a variant with 0 rows (not in cart yet) or >1 rows
// (e.g. a paid duplicate alongside the gift) is skipped, so we never dim a qualifying/paid row.
export function confidentDimVariants(
  rowVariantIds: readonly string[],
  wanted: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const id of rowVariantIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return wanted.filter((id) => counts.get(id) === 1);
}

// Dim ONLY the in-cart gift line(s) for the given gift variant ids (numeric, matching the row's
// data-quantity-variant-id), in both the drawer and /cart. Visual only — toggles a class, never mutates
// cart data. Clears any prior dim first (idempotent / re-applyable on re-render). Confident rows only
// (see confidentDimVariants); a row we can't confidently identify is left untouched. Never throws.
export function dimGiftRows(wantedNumericIds: readonly string[], dim: boolean): void {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    return;
  }
  for (const el of Array.from(doc.querySelectorAll('.' + ROW_DIM_CLASS))) {
    el.classList.remove(ROW_DIM_CLASS);
  }
  if (!dim || wantedNumericIds.length === 0) {
    return;
  }
  const rows = Array.from(doc.querySelectorAll('[data-quantity-variant-id]'));
  const confident = new Set(
    confidentDimVariants(
      rows.map((r) => r.getAttribute('data-quantity-variant-id') ?? ''),
      wantedNumericIds,
    ),
  );
  if (confident.size === 0) {
    return;
  }
  for (const r of rows) {
    if (confident.has(r.getAttribute('data-quantity-variant-id') ?? '')) {
      // The data attr is on the quantity input in both contexts; dim the whole ROW it belongs to.
      (r.closest('.cart-item, tr, li') ?? r).classList.add(ROW_DIM_CLASS);
    }
  }
}
