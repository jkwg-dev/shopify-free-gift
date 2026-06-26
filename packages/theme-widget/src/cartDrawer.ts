// Cart-drawer overlay mount + gift-line hiding (Phase 5b-2b-1). The perception UI (graph + chooser)
// is mounted on document.body — OUTSIDE the drawer's re-rendered subtree — so it SURVIVES the theme
// replacing the drawer's inner HTML on every cart change (Dawn's Sections-API render wipes
// `.drawer__inner`). It is positioned over the open drawer (opaque card), above the backdrop.
//
// It also HIDES the app-added gift line(s) from the drawer's product list (visual only — the line
// still EXISTS in the cart so the gift ships at $0): the gift appears only in our panel. Re-applied on
// every drawer re-render. The hiding logic is resilient (match per-line by index+variant, else a
// unique variant row, else DON'T hide) so it can't hide the wrong row on a different theme.
//
// PORTABLE: drawer element + open signal are detected with resilient defaults and overridable via data
// attributes. Dawn assumption: <cart-drawer> toggles `active`; rows are `#CartDrawer-Item-{index}`
// with a `[data-quantity-variant-id]`.
import { GIFT_LINE_PROPERTY } from '@free-gift-engine/core';

const OVERLAY_Z = 2147482000; // above the drawer + its backdrop
const GUTTER = 10;

const DRAWER_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '.cart-drawer',
  '[class*="cart-drawer" i]',
  '.drawer--cart',
  'cart-notification',
];
const PANEL_SELECTORS = ['.drawer__inner', '.cart-drawer__inner', '[role="dialog"]'];
const ROW_SELECTORS = 'tr, li, .cart-item, [class*="cart-item" i]';
// Dawn's close() removes only `active` (leaves `animate`), so `animate` is NOT an open signal.
const OPEN_CLASSES = ['active', 'is-open', 'open', 'drawer--active'];

// --- pure: which cart lines are app-added gift lines (1-based index + variant id), for hiding -----

export type CartItemLike = {
  readonly variant_id: number;
  readonly properties: Readonly<Record<string, unknown>> | null;
};
export type GiftRowTarget = { readonly index1: number; readonly variantId: number };

// The gift lines to hide: each carries its 1-based position (the drawer renders rows in cart order)
// and its variant id, so the DOM can target the exact row (not every row of that variant — a paid
// duplicate of a gift variant stays visible).
export function giftRowTargets(items: readonly CartItemLike[]): GiftRowTarget[] {
  const targets: GiftRowTarget[] = [];
  items.forEach((item, i) => {
    if (item.properties != null && item.properties[GIFT_LINE_PROPERTY] != null) {
      targets.push({ index1: i + 1, variantId: item.variant_id });
    }
  });
  return targets;
}

// --- DOM ----------------------------------------------------------------------------------------

export type DrawerMountOptions = {
  readonly drawerSelector?: string | undefined;
  readonly openClass?: string | undefined;
  // Called after the drawer opens or re-renders (rows changed) — the storefront re-hides gift rows.
  readonly onRender?: (() => void) | undefined;
};

export type DrawerMount = {
  readonly container: HTMLElement; // render the perception UI here
  readonly drawerEl: HTMLElement | null; // the detected drawer (for row hiding); null if none
  refresh(): void; // reposition + show/hide (call after a render)
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
  return drawer.offsetParent !== null && drawer.getBoundingClientRect().width > 0;
}

function rowHasVariant(row: HTMLElement, variantId: number): boolean {
  return (
    row.querySelector(`[data-quantity-variant-id="${variantId}"]`) !== null ||
    row.getAttribute('data-variant-id') === String(variantId)
  );
}

// Visually hide the gift line rows (display:none). VISUAL ONLY — never mutates cart data, never
// touches non-gift rows. Per-line precise (index + variant); falls back to a uniquely-identified
// variant row; otherwise leaves the row visible (safe on unknown themes).
export function hideGiftLineRows(drawer: HTMLElement, targets: readonly GiftRowTarget[]): void {
  for (const t of targets) {
    const byIndex =
      drawer.querySelector<HTMLElement>(`#CartDrawer-Item-${t.index1}`) ??
      drawer
        .querySelector<HTMLElement>(`[data-index="${t.index1}"]`)
        ?.closest<HTMLElement>(ROW_SELECTORS) ??
      null;
    if (byIndex !== null && rowHasVariant(byIndex, t.variantId)) {
      byIndex.style.display = 'none';
      continue;
    }
    const byVariant = Array.from(
      drawer.querySelectorAll<HTMLElement>(`[data-quantity-variant-id="${t.variantId}"]`),
    );
    if (byVariant.length === 1) {
      const row = byVariant[0]!.closest<HTMLElement>(ROW_SELECTORS);
      if (row !== null) {
        row.style.display = 'none';
      }
    }
    // else: cannot confidently identify the single gift row -> do NOT hide (safe)
  }
}

export function mountDrawerOverlay(opts: DrawerMountOptions = {}): DrawerMount {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-fge-overlay', '');
  overlay.style.cssText = `position:fixed;z-index:${OVERLAY_Z};display:none;box-sizing:border-box;`;
  const container = document.createElement('div');
  container.setAttribute('data-fge-chooser', '');
  overlay.append(container);
  document.body.append(overlay);

  const drawer = findDrawer(opts.drawerSelector);

  const panelOf = (): HTMLElement | null =>
    drawer === null
      ? null
      : (PANEL_SELECTORS.map((s) => drawer.querySelector<HTMLElement>(s)).find(
          (el) => el !== null,
        ) ?? drawer);

  const position = (): void => {
    if (drawer === null) {
      overlay.style.cssText =
        `position:fixed;z-index:${OVERLAY_Z};left:0;right:0;bottom:0;display:block;` +
        `box-sizing:border-box;max-height:50vh;overflow:auto;`;
      return;
    }
    const panel = panelOf() as HTMLElement;
    const r = panel.getBoundingClientRect();
    // Contained opaque card at the TOP of the drawer panel, capped so the cart stays usable below.
    overlay.style.display = 'block';
    overlay.style.left = `${r.left + GUTTER}px`;
    overlay.style.top = `${r.top + GUTTER}px`;
    overlay.style.width = `${Math.max(0, r.width - GUTTER * 2)}px`;
    overlay.style.maxHeight = `${Math.max(160, Math.round(r.height * 0.62))}px`;
    overlay.style.overflow = 'auto';
    // RESERVE space so the cart content flows BELOW the card (no overlap/bleed at the card's edge).
    // padding-top on the panel = the card's height + gutters; recomputed each position().
    panel.style.paddingTop = `${overlay.offsetHeight + GUTTER * 2}px`;
  };

  const refresh = (): void => {
    if (drawer === null) {
      position();
      return;
    }
    if (isOpen(drawer, opts.openClass)) {
      position();
    } else {
      overlay.style.display = 'none';
    }
  };

  // refresh + notify the storefront to re-hide gift rows (rows changed). Debounced — a re-render emits
  // many mutations.
  let tick: ReturnType<typeof setTimeout> | undefined;
  const renderTick = (): void => {
    if (tick !== undefined) clearTimeout(tick);
    tick = setTimeout(() => {
      refresh();
      opts.onRender?.();
    }, 40);
  };

  if (drawer !== null) {
    // Open/close: the <cart-drawer> element's own class/aria (it persists across inner re-render).
    new MutationObserver(renderTick).observe(drawer, {
      attributes: true,
      attributeFilter: ['class', 'aria-hidden'],
    });
    // Inner re-render: the theme replaces row HTML (childList in the subtree). NOT attributes, so our
    // own display:none / padding writes don't retrigger it (no loop).
    new MutationObserver(renderTick).observe(drawer, { childList: true, subtree: true });
  }
  window.addEventListener('resize', refresh, { passive: true });
  window.addEventListener('scroll', refresh, { passive: true });
  renderTick();

  return { container, drawerEl: drawer, refresh };
}
