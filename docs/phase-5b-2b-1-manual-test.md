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

## Visual polish checks (5b-2b-1 polish pass)

| #   | Check                            | Expected                                                                                                                                                                                                                            |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Panel background                 | The panel is a **solid opaque card** (white) with border + shadow — NO cart-line text bleeds through from behind it                                                                                                                 |
| P2  | Size / no trap                   | The card sits at the **top of the drawer panel** with a gutter, capped at ~70% height (scrolls internally); the cart items + **checkout button remain visible and usable** below; backdrop click still closes                       |
| P3  | Progress = visual stepper        | A horizontal **track with 3 nodes** at CA$500 / CA$1,000 / CA$1,500; the reached portion is **filled**; the current (highest reached) tier node is highlighted (gold); headline reads **"Spend CA$X more to unlock <next gift>"\*\* |
| P4  | Highest-tier-only clarity        | Subnote: **"You receive the gift for your highest unlocked tier — not one per step."** The gift panel shows only the **current** tier's gift (never all three as selectable)                                                        |
| P5  | Gift cards with images           | Each gift option is a **card row with a product image** + name + status; selected card is clearly marked; status reads "Unlocked · added free" / "Currently unavailable"                                                            |
| P6  | OR selectable / AND bundle / OOS | tier-1 OR: Ice/Dawn selectable cards (radio, auto-add); tier-2 AND: both gifts shown as cards (no radios); tier-3 OR: Liquid L (OOS) disabled                                                                                       |
| P7  | Decline                          | "Add my free gift" checkbox is styled within the panel, checked by default; unchecking removes the gift                                                                                                                             |
| P8  | Survives re-render               | After add/remove/qty change (drawer re-renders), the panel stays styled + correct (it's a body overlay, not wiped)                                                                                                                  |

If the panel's vertical placement needs tuning on the production theme, set `data-drawer-selector` /
`data-drawer-open-class` on the app embed (no code change). The model-C question (gift also sold at
full price) is recorded for a later task — see `docs/phase-5b-2b-plan.md`.

## Round 2 checks (black palette + hide gift line + layout)

| #   | Check               | Expected                                                                                                                                                                 |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Color               | Panel accents are **black/neutral** (progress fill, current-tier node, selected card, checkbox) — no green/gold                                                          |
| R2  | Gift not duplicated | The gift appears **only in our panel**. The drawer's product list shows **only the qualifying/paid items** — the "$699.95 → $0.00" gift line is **hidden** from the list |
| R3  | Gift still real     | Despite being hidden from the list, the gift line still EXISTS (carries the code → $0): **subtotal unchanged, $0 gift at checkout, order includes the gift**             |
| R4  | Non-gift untouched  | Paid/qualifying lines are never hidden or altered; quantities preserved                                                                                                  |
| R5  | Layout              | The panel is a clean opaque card; the cart items read as a **separate section below it** (no overlap/bleed at the card's lower edge); close + checkout usable            |
| R6  | Survives re-render  | After add/remove/qty change, the gift line stays hidden and the panel stays correct (re-applied on re-render)                                                            |
| R7  | Fallback safety     | If a gift row can't be confidently identified (other theme), it is **left visible** rather than hiding the wrong row                                                     |

Hiding is VISUAL only (display:none on the gift row) — cart data, the BXGY code, subtotal and checkout
are never touched. Model-C question remains recorded, not solved.
