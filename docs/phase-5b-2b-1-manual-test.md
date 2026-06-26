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

## Round 3 checks (injected sections; gift line NOT hidden)

Layout reworked: the perception UI is now **injected into the drawer flow** (no floating overlay),
split into two parts, and the gift line is **no longer hidden** from the cart list.

| #   | Check                   | Expected                                                                                                                                                                                                             |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Stepper placement       | A **slim progress row** appears right under the "Your cart" header — blended in (no shadow, no boxed/floating card, transparent background)                                                                          |
| T2  | Chooser placement       | The "Choose your free gift" section appears **below the cart line items** (scroll down to reach it), above the subtotal/checkout; reads as part of the drawer (light divider, not a floating card)                   |
| T3  | Gift shown in cart list | The free gift renders **normally in the cart product list at $0** ("$699.95 → $0.00") — NOT hidden. The chooser (choice/progress) and the cart line ($0 receipt) are complementary, not duplicated                   |
| T4  | Survives re-render      | After add/remove/qty change (drawer re-renders), BOTH injected sections are **re-injected** (not lost); selection preserved; no flicker loop                                                                         |
| T5  | No overlap              | No overlap with "Your cart" or the cart items; close + checkout usable                                                                                                                                               |
| T6  | Black/neutral           | Stepper fill, current node, selected card, checkbox are black/neutral                                                                                                                                                |
| T7  | Cards                   | Gift cards show images; OR selectable (radio + auto-add); AND bundle shows both; OOS (Liquid L) disabled                                                                                                             |
| T8  | Fallback                | If the header/items anchors aren't found (other theme), both sections fall back to a single safe mount in the drawer panel (no wrong-place injection, no hard-fail) — override the drawer via `data-drawer-selector` |
| T9  | Correctness             | Subtotal, the $0 gift at checkout, and the order contents are unchanged                                                                                                                                              |

## Round 4 checks (visual stepper fits; chooser capped; cart stays usable)

> DEPLOY FIRST: `pnpm --filter @free-gift-engine/theme-widget build` then `shopify app deploy`. The
> "overlay fills the drawer / stepper is just text labels" state is a **pre-injection build** — the
> injected sections + visual stepper land only with the freshly deployed `free-gift.js`.

| #   | Check               | Expected                                                                                                                                                                   |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Cart visible        | Cart line items, subtotal, and checkout are visible/usable — the widget does NOT cover them                                                                                |
| V2  | Stepper is visual   | Under "Your cart": a slim horizontal **track** with a **node per tier**, the reached portion **filled**, the current tier marked — not just a row of price text            |
| V3  | Labels fit          | CA$500 / CA$1,000 / CA$1,500 labels **fit within the track** — the last label is right-aligned and does NOT clip ("CA$1,50…")                                              |
| V4  | Chooser below items | "Choose your free gift" is **below the cart line items** (scroll to reach); for the 8-option tier it **scrolls internally** (capped ~42vh) so the checkout stays on screen |
| V5  | Gift in cart at $0  | The free gift shows normally in the cart list at $0 (not hidden); the chooser is choice/progress, not a duplicate                                                          |
| V6  | Survives re-render  | Both sections re-inject on cart change; selection preserved                                                                                                                |
| V7  | Black + cards       | Black/neutral palette; image cards; OR selectable / AND bundle / OOS ("Currently unavailable")                                                                             |

## Round 5 checks (stepper actually renders; top section compact)

> Confirmed by live DOM inspection: injection ORDER is correct (header → stepper → cart items →
> chooser → footer). These fixes are CSS/sizing only. Redeploy `free-gift.js` then re-inspect.

Root causes fixed this round:

- **Track/fill/dots invisible** (`offsetParent === null`, only labels showed): the dot used
  `background:var(--fge-surface)`, an **undefined** token → transparent (white-on-white), and the
  track relied on `inset:0` + a 6px parent. Rebuilt with **explicit px geometry** (14px bar area,
  4px track at `top:5px`, 12px dots, defined `#fff` dot fill) so it renders regardless of theme resets.
- **Top section 124px tall** squeezing the cart items: dropped the eyebrow and the big "You've
  unlocked…" headline; now one small 12px headline + the bar (~70px total). The theme's own "Your
  cart" header stays the visual top of the drawer.

| #   | Check          | Expected                                                                                                                      |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| S1  | Track visible  | A slim grey horizontal **line** spans the stepper width (not just text)                                                       |
| S2  | Fill visible   | The reached portion is a **black bar** from the left, width = confirmed subtotal / top tier                                   |
| S3  | Nodes visible  | A **dot per tier** sits on the track; unreached = white w/ grey ring, reached/current = solid black (current has a soft ring) |
| S4  | Labels fit     | CA$500 / CA$1,000 / CA$1,500 fit; the last is right-aligned and does NOT clip                                                 |
| S5  | Top is compact | The top section is a slim row (~one small line + the bar); no big headline; cart line items below have clear visible space    |
| S6  | Hierarchy      | "Your cart" (theme header) reads as the top; our row blends under it as progress                                              |
| S7  | Cart usable    | Cart lines, subtotal, and checkout are visible/usable; the chooser scrolls internally (≤42vh) below the items                 |

## Round 6 checks (theme :empty immunity; banner card; init-timing)

> ROOT CAUSE (theme, not our CSS): Dawn's base.css has `div:empty{display:none}`. Our track, fill,
> and tier dots are intentionally EMPTY divs, so the theme's `:empty` rule (it outranks a plain class)
> hid them — only the text labels (non-empty) survived. The no-image card placeholder hit the same rule.
> Fixed with a `display:block !important` immunity rule on those four selectors. Verify the COMPUTED
> style (not just authored CSS): the bar/dots must read `display: block`, not `none`.

| #   | Check          | Expected                                                                                                                                                                                  |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Track computed | `.fge-stepper__track` computed `display` = block (grey line visible)                                                                                                                      |
| E2  | Fill computed  | `.fge-stepper__fill` computed `display` = block; black, overlaps the track from the left, width = reached %                                                                               |
| E3  | Dots computed  | `.fge-step__dot` computed `display` = block; a circle at EACH tier (CA$500 / CA$1,000 / CA$1,500)                                                                                         |
| E4  | Dot states     | Reached/current = solid black (current has a soft ring); not-yet-reached = white w/ grey outline                                                                                          |
| E5  | No-image card  | An OR option with no image still shows its placeholder box (not collapsed by `:empty`)                                                                                                    |
| B1  | Banner card    | The progress section is a subtle outlined card (1px border, light `#fafafa` fill, 12px radius, no heavy shadow)                                                                           |
| B2  | Headline       | "Spend CA$X more to unlock <gift>" (or "You've unlocked…" at top tier); NOT "Your cart" (that's the theme's header above ours)                                                            |
| B3  | Height         | The card has room for headline + bar + dots + labels (bar area 16px, dots 14px); nothing clipped                                                                                          |
| T1  | No tier flash  | On fresh drawer open the banner shows "Checking your cart…" (neutral), then snaps to the real tier once /validate resolves — it must NOT briefly show a wrong lower tier ("Reach CA$500") |

## Round 7 checks (chooser in scroll flow; single header; centered nodes; animation)

> All four are refinements on a working stepper. Redeploy `free-gift.js` then re-inspect.

| #   | Check                | Expected                                                                                                                                                                                                                                                                       |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Chooser scroll order | Drawer reads: [our progress banner] → cart line items → "Choose your free gift". The chooser is INSIDE the scrollable region (scroll past the items to reach it), NOT pinned above the footer                                                                                  |
| C2  | No inner scrollbar   | The chooser has no `max-height`/own scrollbar; the drawer's own scroll reveals it; subtotal/checkout stay reachable                                                                                                                                                            |
| H1  | Single "cart" header | Only the theme's "Your cart" shows at top; our banner's pending text reads "Loading your free gift…" (no second "…cart…"), then resolves to the real tier                                                                                                                      |
| H2  | Banner under header  | Our banner sits directly below the "Your cart / Continue shopping" row                                                                                                                                                                                                         |
| N1  | Centered nodes       | The CA$500/CA$1,000/CA$1,500 dots are a centered group (≈25/50/75%), not bunched at the right; intentional empty track past the last node                                                                                                                                      |
| N2  | Fill tracks dots     | The black fill reaches a dot exactly when that tier is reached (e.g. tier-1 cart → fill at the first dot, not 1/3 of the way)                                                                                                                                                  |
| A1  | Fill animates        | Crossing a tier, the fill width slides smoothly to the new value (CSS transition) rather than snapping; current-dot ring fades in. (Note: the ~5–6s staggered convergence itself is a 5b-2b-2 latency item, not fixed here — the transition just softens the eventual update.) |
| A2  | Authoritative        | The fill animates only to the server-confirmed value — never optimistically ahead of /validate                                                                                                                                                                                 |
| A3  | Reduced motion       | With OS "reduce motion", the fill/dots update without transition                                                                                                                                                                                                               |

## Round 8 checks (product-grouped chooser; single title; persistent decline)

> Redeploy `free-gift.js` then re-inspect.

| #   | Check                  | Expected                                                                                                                                                                  |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | One card per product   | A multi-variant product (Ice/Dawn; S/M/L) shows ONE card titled by the PRODUCT, not one card per variant                                                                  |
| P2  | Inner variant picker   | Selecting that product reveals pill buttons (Ice/Dawn or S/M/L) inside the card; the chosen variant is highlighted and its label shows in the status ("Ice · added free") |
| P3  | OOS variant disabled   | An out-of-stock variant (e.g. Liquid L) is a disabled, struck-through pill in the picker; the product card itself is still selectable if any sibling is in stock          |
| P4  | Single-variant product | A product with one variant shows a plain card with NO inner picker (unchanged)                                                                                            |
| P5  | Choice wiring          | Switching the variant re-validates and swaps the gift line + code (one optionId per tier, same as before)                                                                 |
| D1  | One "Your cart"        | Only the theme's drawer header "Your cart" shows; the duplicate H1.title--primary inside the drawer is hidden (cart PAGE title unaffected)                                |
| X1  | Decline persists       | Unchecking "Add my free gift" removes the gift BUT the checkbox stays visible (with a note); re-checking re-adds the gift                                                 |
| X2  | Toggle responsive      | The checkbox reflects its new state immediately on click even though the cart removal/re-add takes a moment (latency itself is 5b-2b-2)                                   |

## Round 9 checks (product title; inline chips; chips inside the card)

> IMPORTANT for V1: the product TITLE comes from `productLabel`, added to the /config response in
> round 8 (server-side). That endpoint runs in the Next app (App Proxy on Vercel) — it must be
> REDEPLOYED, not just `shopify app deploy` (which only ships the theme widget). Until the server is
> redeployed, the widget falls back to the variant label ("S"). The widget code already prefers the
> product title; this row verifies it after the server deploy.

| #   | Check             | Expected                                                                                                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Product title     | A grouped multi-variant card's title is the PRODUCT name (e.g. "The Collection Snowboard: Liquid"), NOT a variant ("S"). [needs the config server redeployed] |
| V2  | Chips are pills   | The S/M/L chips are small inline rounded pills in a row (computed `display: inline-flex`, width auto) — not full-width blocks with broken borders             |
| V3  | Chips inside card | The chips sit INSIDE the selected card's body, directly under the product title: [radio] [image] Product Name / (S M L). Not outside the card                 |
| V4  | OOS chip          | An out-of-stock variant (Liquid L) is a disabled, struck-through pill; the card stays selectable if any sibling is in stock                                   |
| V5  | Single-variant    | A single-variant product is still a plain card with no chips                                                                                                  |
| V6  | Choice wiring     | Tapping a chip swaps the gift line + code (one optionId per tier), unchanged                                                                                  |
