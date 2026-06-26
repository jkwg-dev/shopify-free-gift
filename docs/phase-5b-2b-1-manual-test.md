# Phase 5b-2b-1 — manual storefront test (drawer + graph + 422 fallback)

5b-2b-1 builds the perception STRUCTURE: the chooser/graph mount as an overlay over the cart drawer
(above the backdrop, surviving the drawer's re-render), the authoritative tier progress graph, and the
runtime gift-unavailable fallback. Pure parts are unit-tested; this is the manual DOM/theme check.

> Prereq: 5b-2a verified; the corrected campaign is seeded (tier-3 has no Hydrogen) and all gift
> products are tagged + excluded + published. Deploy the rebuilt `extensions/theme/assets/free-gift.js`
> (`pnpm --filter @free-gift-engine/theme-widget build` then `shopify app deploy`), with the **app
> embed enabled** (Theme settings → App embeds → "Free Gift Engine").

## Mounting approach (why)

Inspected the dev theme (Dawn): `<cart-drawer>` toggles class **`active`** on open/close, and on every
cart change the theme **replaces `.drawer__inner` / `#CartDrawer` innerHTML** (Sections API) — wiping
anything injected inside. So the perception UI is mounted as a **`<body>` overlay** (`[data-fge-overlay]`,
high z-index) positioned over the drawer and shown/hidden with it: it sits above the backdrop
(clickable) and **survives the inner re-render** because it lives outside that subtree. Drawer detection

- open class are resilient with fallbacks and can be overridden per theme via
  `data-drawer-selector` / `data-drawer-open-class` on the app embed (production theme ≠ dev theme).

## Steps — record expected vs actual

| #   | Action                                                                        | Expected                                                                                                                                                                                                                | Actual |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Open the cart drawer (cart icon) with items in cart                           | The chooser + progress graph appear **within/over the drawer, ABOVE the backdrop, and are CLICKABLE** (not buried at the bottom of the page)                                                                            |        |
| 2   | Add / remove / change qty of items (drawer re-renders)                        | The overlay **stays visible and clickable** (not wiped); content updates from the server result                                                                                                                         |        |
| 3   | Close the drawer                                                              | The overlay is **hidden**; reopening shows it again                                                                                                                                                                     |        |
| 4   | Cross tiers (add qualifying product up past CA$500 / CA$1000 / CA$1500)       | Graph marks reached tiers, shows the **current/unlocked** tier, and **"Spend CA$X more to unlock <gift>"** for the next tier; X uses the presentment threshold (matches what's enforced)                                |        |
| 5   | Below tier 1 (small cart)                                                     | Graph shows the ladder with all tiers locked and the **tier-1 target threshold** (no guessed delta)                                                                                                                     |        |
| 6   | Deliberately-unavailable gift (see below) → select it / qualify into its tier | That option is **disabled with a "currently unavailable" note**; other options remain selectable; an AND tier with one unavailable item shows **"can't be fully added"** — never shows the gift as added when it wasn't |        |

## How to make a gift deliberately unavailable (step 6)

Pick a tier-3 gift product and **unpublish it from the Online Store channel** (Admin → product →
Sales channels → uncheck Online Store) OR set its inventory to 0. Then qualify into tier 3 and select
that option. The widget's `cart/add.js` returns **422**; `applyCartPlan` records the failure,
`failedAddVariantIds` feeds the chooser's `unavailableVariantIds`, and the option renders disabled +
noted. Re-publish/restock afterwards.

## Out of scope (5b-2b-2 — seams left, do not expect)

Pending hint (spinner + "Bringing your free gift…"), delay measurement/optimization, cosmetic grouping
of the split qualifying line (accepted inherent BXGY behavior), fresh-load stale-discount auto-clear,
mobile layout, and full a11y. The 422 fallback is designed so the (next-step) pending hint resolves to
the unavailable state rather than spinning.

## After 5b-2b-1

Record results; if the overlay placement needs visual tuning on this theme, note it (placement polish
is acceptable to defer). Then proceed to 5b-2b-2 (pending hint + delay + polish).
