// Cart-drawer section injection (Phase 5b-2b-1 layout rework). Instead of a floating body overlay,
// we INJECT two in-flow sections into the drawer so they blend into the cart content:
//   • a slim progress stepper right AFTER the "Your cart" header, and
//   • the "Choose your free gift" chooser INSIDE the scrollable items region, after the line items
//     (scroll past the cart to reach it — never pinned above the footer competing for top space).
// The theme replaces the drawer's inner HTML on every cart change (Dawn Sections API), which detaches
// our sections — so we RE-ATTACH them on every re-render via a childList/subtree MutationObserver. We
// hold the element references, so re-attaching only RE-PARENTS them (content + selection survive).
//
// Loop discipline: re-attaching mutates the subtree, which would retrigger the observer — so we
// DISCONNECT the observer around our writes and takeRecords() before reconnecting (no infinite loop).
//
// PORTABLE: anchors are found by stable Dawn structures with resilient fallbacks; if neither anchor is
// found we fall back to a single mount appended to the drawer panel (never inject into the wrong
// place, never hard-fail). Override the drawer element via data-drawer-selector. Assumptions (Dawn):
// header `.drawer__header`, line-item list `#CartDrawer-CartItems`/`.drawer__contents`, footer
// `.drawer__footer`.

const DRAWER_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '.cart-drawer',
  '[class*="cart-drawer" i]',
  '.drawer--cart',
  'cart-notification',
];
const PANEL_SELECTORS = ['.drawer__inner', '.cart-drawer__inner', '[role="dialog"]'];
const HEADER_SELECTORS = ['.drawer__header', '.cart-drawer__header', '[class*="drawer__header" i]'];
const ITEMS_SELECTORS = [
  '#CartDrawer-CartItems',
  '.drawer__contents',
  '.js-contents',
  '.cart-items',
  '[class*="cart-items" i]',
];
const FOOTER_SELECTORS = ['.drawer__footer', '.cart-drawer__footer', '[class*="drawer__footer" i]'];

export type DrawerSectionsOptions = {
  readonly drawerSelector?: string | undefined;
};

export type DrawerSections = {
  // Render the progress stepper into this element (injected under the cart header).
  readonly stepperEl: HTMLElement;
  // Render the chooser into this element (injected below the line items).
  readonly chooserEl: HTMLElement;
  // Force a re-attach (e.g. after our reconcile renders new content).
  attach(): void;
};

function findFirst(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el !== null) {
      return el;
    }
  }
  return null;
}

function findDrawer(selectorOverride?: string): HTMLElement | null {
  const selectors = selectorOverride ? [selectorOverride, ...DRAWER_SELECTORS] : DRAWER_SELECTORS;
  return findFirst(document, selectors);
}

export function mountDrawerSections(opts: DrawerSectionsOptions = {}): DrawerSections {
  const stepperEl = document.createElement('div');
  stepperEl.className = 'fge fge-stepper-wrap';
  stepperEl.setAttribute('data-fge-stepper', '');
  const chooserEl = document.createElement('div');
  chooserEl.className = 'fge';
  chooserEl.setAttribute('data-fge-chooser', '');

  const drawer = findDrawer(opts.drawerSelector);

  // Place our two sections at their anchors (in the cart flow). Idempotent — insertAdjacentElement
  // re-parents the SAME nodes, so content/selection is preserved across re-renders.
  const doAttach = (): void => {
    if (drawer === null) {
      if (stepperEl.parentNode === null) document.body.append(stepperEl, chooserEl); // last resort
      return;
    }
    const panel = findFirst(drawer, PANEL_SELECTORS) ?? drawer;

    // Stepper: directly under the theme's "Your cart" header row (single header, our banner below it).
    const header = findFirst(panel, HEADER_SELECTORS);
    if (header !== null) {
      header.insertAdjacentElement('afterend', stepperEl);
    } else if (stepperEl.parentNode === null) {
      panel.prepend(stepperEl); // fallback: top of the panel
    }

    // Chooser: INSIDE the scrollable items region, as its LAST child — so it scrolls with the cart
    // content (reached by scrolling past the items), never pinned above the footer. Fallbacks keep it
    // safely placed if the items region isn't found on a given theme.
    const items = findFirst(panel, ITEMS_SELECTORS);
    if (items !== null) {
      items.append(chooserEl);
    } else {
      const footer = findFirst(panel, FOOTER_SELECTORS);
      if (footer !== null) {
        footer.insertAdjacentElement('beforebegin', chooserEl);
      } else if (chooserEl.parentNode === null) {
        panel.append(chooserEl); // last resort: end of the panel
      }
    }
  };

  let observer: MutationObserver | null = null;
  const attach = (): void => {
    // Disconnect around our DOM writes + clear the queued mutations they produce → no observer loop.
    observer?.disconnect();
    try {
      doAttach();
    } finally {
      if (observer !== null && drawer !== null) {
        observer.takeRecords();
        observer.observe(drawer, { childList: true, subtree: true });
      }
    }
  };

  if (drawer !== null) {
    // Re-attach whenever the theme re-renders the drawer's inner HTML (detaching our sections).
    observer = new MutationObserver(() => attach());
    observer.observe(drawer, { childList: true, subtree: true });
  }
  attach();

  return { stepperEl, chooserEl, attach };
}
