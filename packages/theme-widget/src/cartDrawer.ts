// Cart-drawer overlay mount (Phase 5b-2b-1). The perception UI (graph + chooser) is mounted on
// document.body — OUTSIDE the drawer's re-rendered subtree — so it SURVIVES the theme replacing the
// drawer's inner HTML on every cart change (Dawn's Sections-API render wipes `.drawer__inner`). It is
// positioned over the open drawer and shown/hidden with it, above the backdrop (clickable).
//
// PORTABLE: the drawer element + its "open" signal are detected with resilient defaults and can be
// overridden per theme via data attributes (no dependency on inner markup). Dawn assumption: the
// `<cart-drawer>` element toggles the `active` class on open/close.
//
// Pure DOM glue — manual-tested. No business logic here.

const OVERLAY_Z = 2147482000; // above the drawer + its backdrop, below nothing that matters

// Resilient drawer-element candidates (most specific first). Override with data-drawer-selector.
const DRAWER_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '.cart-drawer',
  '[class*="cart-drawer" i]',
  '.drawer--cart',
  'cart-notification',
];

// Panel (the visible card) within the drawer, to align the overlay to. Falls back to the drawer.
const PANEL_SELECTORS = ['.drawer__inner', '.cart-drawer__inner', '[role="dialog"]'];

// NOTE: Dawn's close() removes only `active` (it leaves `animate` on), so `animate` is NOT an
// open signal — using it would keep the overlay visible after close. The open signal is `active`.
const OPEN_CLASSES = ['active', 'is-open', 'open', 'drawer--active'];

export type DrawerMountOptions = {
  readonly drawerSelector?: string | undefined;
  readonly openClass?: string | undefined;
};

export type DrawerMount = {
  // Render the perception UI into this element.
  readonly container: HTMLElement;
  // Re-evaluate open state + re-position (call after a cart change / our reconcile).
  refresh(): void;
};

function findDrawer(selectorOverride?: string): HTMLElement | null {
  const selectors = selectorOverride ? [selectorOverride, ...DRAWER_SELECTORS] : DRAWER_SELECTORS;
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el !== null) {
      return el;
    }
  }
  return null;
}

function isOpen(drawer: HTMLElement, openClassOverride?: string): boolean {
  if (openClassOverride) {
    return drawer.classList.contains(openClassOverride);
  }
  if (OPEN_CLASSES.some((c) => drawer.classList.contains(c))) {
    return true;
  }
  if (drawer.getAttribute('aria-hidden') === 'false') {
    return true;
  }
  // Last resort: visible + on-screen (has layout box).
  return drawer.offsetParent !== null && drawer.getBoundingClientRect().width > 0;
}

export function mountDrawerOverlay(opts: DrawerMountOptions = {}): DrawerMount {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-fge-overlay', '');
  overlay.style.cssText = `position:fixed;z-index:${OVERLAY_Z};display:none;box-sizing:border-box;`;
  const container = document.createElement('div');
  container.setAttribute('data-fge-chooser', ''); // perception UI mounts here
  overlay.append(container);
  document.body.append(overlay);

  const drawer = findDrawer(opts.drawerSelector);

  const position = (): void => {
    if (drawer === null) {
      // Fallback (no drawer found — e.g. cart page or an unknown theme): show as a fixed bottom
      // panel so it's at least visible/clickable. Set data-drawer-selector for proper placement.
      overlay.style.cssText =
        `position:fixed;z-index:${OVERLAY_Z};left:0;right:0;bottom:0;display:block;` +
        `box-sizing:border-box;max-height:50vh;overflow:auto;`;
      return;
    }
    const panel = (PANEL_SELECTORS.map((s) => drawer.querySelector<HTMLElement>(s)).find(
      (el) => el !== null,
    ) ?? drawer) as HTMLElement;
    const r = panel.getBoundingClientRect();
    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.maxHeight = `${Math.max(120, r.height)}px`;
    overlay.style.overflow = 'auto';
  };

  const refresh = (): void => {
    if (drawer === null) {
      position(); // fallback panel is always shown
      return;
    }
    if (isOpen(drawer, opts.openClass)) {
      overlay.style.display = 'block';
      position();
    } else {
      overlay.style.display = 'none';
    }
  };

  if (drawer !== null) {
    // React to the theme toggling the open class / aria on the drawer element (it persists across
    // the inner re-render, so this observer keeps working).
    new MutationObserver(refresh).observe(drawer, {
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden'],
    });
  }
  window.addEventListener('resize', refresh, { passive: true });
  window.addEventListener('scroll', refresh, { passive: true });
  refresh();

  return { container, refresh };
}
