// Cart section injection for BOTH the cart DRAWER and the full /cart PAGE (Phase 5b-2b-1). Instead of
// a floating overlay, we inject two in-flow sections — a progress stepper after the cart heading, and
// the chooser by the line items — so they blend into whichever cart surface the shopper is using. The
// drawer and the page expose near-identical anchors (header / items / footer) and both re-render their
// inner HTML via the Sections API on cart change, detaching our nodes — so each context RE-ATTACHES on
// re-render via a childList/subtree MutationObserver. We hold the element references, so re-attaching
// only RE-PARENTS them (content + selection survive).
//
// Loop discipline: re-attaching mutates the subtree, which would retrigger the observer — so we
// DISCONNECT around our writes and takeRecords() before reconnecting (no infinite loop).
//
// The WHERE-to-inject decision is a pure, unit-tested function (planInsertions); doAttach just resolves
// the real anchors and executes the plan. Anchors are resilient with fallbacks; the page context is
// STRICT (skip rather than inject in the wrong place), the drawer keeps its lenient fallbacks so it
// behaves exactly as before. Override the drawer element via data-drawer-selector.

const DRAWER_SELECTORS = [
  'cart-drawer',
  '#CartDrawer',
  '.cart-drawer',
  '[class*="cart-drawer" i]',
  '.drawer--cart',
  'cart-notification',
];
const PANEL_SELECTORS = ['.drawer__inner', '.cart-drawer__inner', '[role="dialog"]'];
const HEADER_SELECTORS = [
  '.drawer__header',
  '.cart-drawer__header',
  '.cart-drawer__head',
  '[class*="drawer__header" i]',
];
const ITEMS_SELECTORS = [
  '#CartDrawer-CartItems',
  '.drawer__contents',
  '.js-contents',
  '.cart-items',
  '[class*="cart-items" i]',
];
const FOOTER_SELECTORS = [
  '.drawer__footer',
  '.cart-drawer__footer',
  '.cart-drawer__bottom',
  '[class*="drawer__footer" i]',
];

// Full /cart page (Dawn): the cart-items section re-renders on qty change; h1.title--primary is the
// heading, #main-cart-items the list, #main-cart-footer a separate section below.
const PAGE_HEADER_SELECTORS = ['h1.title--primary', '.title--primary'];
const PAGE_ITEMS_SELECTORS = ['#main-cart-items', '.cart__items'];
const PAGE_FOOTER_SELECTORS = ['#main-cart-footer'];

export type CartMountOptions = {
  readonly drawerSelector?: string | undefined;
  // Stage 1 two-group transform hook: called after each re-attach (inside the observer-disconnect
  // window, so the transform's DOM writes never loop the observer) with the resolved theme line-items
  // container. The widget applies the grouping plan here. Optional — absence is the pre-grouping behavior.
  readonly onReattach?:
    | ((context: 'drawer' | 'page', itemsEl: HTMLElement | null) => void)
    | undefined;
};

export type CartSection = {
  readonly context: 'drawer' | 'page';
  // Render the progress stepper into this element (injected under the cart heading).
  readonly stepperEl: HTMLElement;
  // Render the chooser into this element (injected by the line items).
  readonly chooserEl: HTMLElement;
  // Force a re-attach (e.g. after our reconcile renders new content).
  attach(): void;
};

// --- pure insertion planning (unit-tested) -------------------------------------------------------

export type AnchorPresence = {
  readonly header: boolean;
  readonly items: boolean;
  readonly footer: boolean;
};
export type MountStrategy = {
  // true: chooser appended INSIDE the items region (drawer scroll flow); false: AFTER the items
  // element (the /cart page, before the footer section).
  readonly chooserInsideItems: boolean;
  // true: skip an element whose anchor is missing (page); false: fall back to the panel (drawer).
  readonly strict: boolean;
};
export type Insertion = {
  readonly el: 'stepper' | 'chooser';
  readonly mode: 'afterend' | 'beforebegin' | 'append' | 'prepend' | 'skip';
  readonly anchor: 'header' | 'items' | 'footer' | 'panel';
};

// Given which anchors are present, decide where each section goes. Pure — no DOM. Captures the
// resilient fallbacks: the drawer (lenient) falls back to the panel; the page (strict) skips.
export function planInsertions(strategy: MountStrategy, present: AnchorPresence): Insertion[] {
  const out: Insertion[] = [];

  if (present.header) {
    out.push({ el: 'stepper', mode: 'afterend', anchor: 'header' });
  } else if (!strategy.strict) {
    out.push({ el: 'stepper', mode: 'prepend', anchor: 'panel' });
  } else {
    out.push({ el: 'stepper', mode: 'skip', anchor: 'panel' });
  }

  if (strategy.chooserInsideItems) {
    if (present.items) {
      out.push({ el: 'chooser', mode: 'append', anchor: 'items' });
    } else if (!strategy.strict && present.footer) {
      out.push({ el: 'chooser', mode: 'beforebegin', anchor: 'footer' });
    } else if (!strategy.strict) {
      out.push({ el: 'chooser', mode: 'append', anchor: 'panel' });
    } else {
      out.push({ el: 'chooser', mode: 'skip', anchor: 'items' });
    }
  } else {
    if (present.items) {
      out.push({ el: 'chooser', mode: 'afterend', anchor: 'items' });
    } else if (!strategy.strict) {
      out.push({ el: 'chooser', mode: 'append', anchor: 'panel' });
    } else {
      out.push({ el: 'chooser', mode: 'skip', anchor: 'items' });
    }
  }

  return out;
}

// --- DOM wiring ----------------------------------------------------------------------------------

type CartMountSpec = {
  readonly context: 'drawer' | 'page';
  readonly observeRoot: HTMLElement; // re-render target to observe; anchors searched within (via panel)
  readonly panelSelectors: readonly string[]; // inner panel to search; [] => use observeRoot
  readonly headerSelectors: readonly string[];
  readonly itemsSelectors: readonly string[];
  readonly footerSelectors: readonly string[];
  readonly chooserInsideItems: boolean;
  readonly strict: boolean;
  readonly onReattach?:
    | ((context: 'drawer' | 'page', itemsEl: HTMLElement | null) => void)
    | undefined;
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

function doAttach(spec: CartMountSpec, stepperEl: HTMLElement, chooserEl: HTMLElement): void {
  const panel =
    spec.panelSelectors.length > 0
      ? (findFirst(spec.observeRoot, spec.panelSelectors) ?? spec.observeRoot)
      : spec.observeRoot;
  const anchors: Record<Insertion['anchor'], HTMLElement | null> = {
    header: findFirst(panel, spec.headerSelectors),
    items: findFirst(panel, spec.itemsSelectors),
    footer: findFirst(panel, spec.footerSelectors),
    panel,
  };
  const plan = planInsertions(
    { chooserInsideItems: spec.chooserInsideItems, strict: spec.strict },
    {
      header: anchors.header !== null,
      items: anchors.items !== null,
      footer: anchors.footer !== null,
    },
  );

  for (const step of plan) {
    const el = step.el === 'stepper' ? stepperEl : chooserEl;
    const anchor = anchors[step.anchor];
    if (anchor === null) {
      continue;
    }
    // IDEMPOTENT: only move a node that is NOT already in its target position. Re-parenting an
    // already-placed node (remove + reinsert) cancels an in-progress CSS transition — so a needless
    // attach() during a render would make the stepper fill SNAP instead of animate. Guard every mode.
    switch (step.mode) {
      case 'skip':
        break;
      case 'afterend':
        if (anchor.nextElementSibling !== el) {
          anchor.insertAdjacentElement('afterend', el);
        }
        break;
      case 'beforebegin':
        if (anchor.previousElementSibling !== el) {
          anchor.insertAdjacentElement('beforebegin', el);
        }
        break;
      case 'append':
        // (Re-)append inside the items region; the panel fallback only if not already placed.
        if (step.anchor === 'items') {
          if (anchor.lastElementChild !== el) {
            anchor.append(el);
          }
        } else if (el.parentNode === null) {
          anchor.append(el);
        }
        break;
      case 'prepend':
        if (el.parentNode === null) {
          anchor.prepend(el);
        }
        break;
    }
  }
}

function mountOne(spec: CartMountSpec): CartSection {
  const stepperEl = document.createElement('div');
  stepperEl.className = 'fge fge-stepper-wrap';
  stepperEl.setAttribute('data-fge-stepper', '');
  const chooserEl = document.createElement('div');
  chooserEl.className = 'fge';
  chooserEl.setAttribute('data-fge-chooser', '');

  let observer: MutationObserver | null = null;
  const attach = (): void => {
    // Disconnect around our DOM writes + clear the queued mutations they produce → no observer loop.
    observer?.disconnect();
    try {
      doAttach(spec, stepperEl, chooserEl);
      // Re-apply the two-group line transform on the same disconnected pass (so its DOM writes don't
      // re-trigger the observer). Resolve the theme line-items container the same way doAttach does.
      if (spec.onReattach !== undefined) {
        const panel =
          spec.panelSelectors.length > 0
            ? (findFirst(spec.observeRoot, spec.panelSelectors) ?? spec.observeRoot)
            : spec.observeRoot;
        spec.onReattach(spec.context, findFirst(panel, spec.itemsSelectors));
      }
    } finally {
      if (observer !== null) {
        observer.takeRecords();
        observer.observe(spec.observeRoot, { childList: true, subtree: true });
      }
    }
  };

  observer = new MutationObserver(() => attach());
  observer.observe(spec.observeRoot, { childList: true, subtree: true });
  attach();

  return { context: spec.context, stepperEl, chooserEl, attach };
}

// Detect every present cart surface (drawer and/or full page) and mount our sections into each, so the
// widget works whichever the shopper uses. Returns one handle per mounted context (empty if neither is
// present — the engine still reconciles without a perception UI).
export function mountCartContexts(opts: CartMountOptions = {}): CartSection[] {
  const specs: CartMountSpec[] = [];

  const drawer = findDrawer(opts.drawerSelector);
  if (drawer !== null) {
    // Observe the .shopify-section wrapper instead of the drawer element itself. The theme (and
    // our refreshDawnTotals fallback) can replace sectionWrapper.innerHTML, which detaches the
    // drawer — if we observed the drawer directly, the MO would be on a dead node and never fire
    // again. The section wrapper survives these swaps; our MO sees the subtree change and re-attaches.
    const sectionRoot = drawer.closest<HTMLElement>('.shopify-section') ?? drawer;
    specs.push({
      context: 'drawer',
      observeRoot: sectionRoot,
      panelSelectors: PANEL_SELECTORS,
      headerSelectors: HEADER_SELECTORS,
      itemsSelectors: ITEMS_SELECTORS,
      footerSelectors: FOOTER_SELECTORS,
      chooserInsideItems: true, // scroll past the items to reach the chooser
      strict: false, // keep the drawer's lenient fallbacks (unchanged behavior)
      onReattach: opts.onReattach,
    });
  }

  // Full /cart page: observe the cart-items SECTION (re-rendered on qty change); it contains the
  // heading + the list. Skip cleanly if the theme doesn't wrap it in a .shopify-section.
  const pageItems = findFirst(document, PAGE_ITEMS_SELECTORS);
  const pageSection = pageItems?.closest('.shopify-section') ?? null;
  if (pageSection instanceof HTMLElement) {
    specs.push({
      context: 'page',
      observeRoot: pageSection,
      panelSelectors: [],
      headerSelectors: PAGE_HEADER_SELECTORS,
      itemsSelectors: PAGE_ITEMS_SELECTORS,
      footerSelectors: PAGE_FOOTER_SELECTORS,
      chooserInsideItems: false, // a normal page: chooser AFTER the items, before the footer section
      strict: true, // never inject in the wrong place on an unknown theme
      onReattach: opts.onReattach,
    });
  }

  return specs.map(mountOne);
}
