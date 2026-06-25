# Phase 5b-1 — live cart wiring: manual test (greentee-dev)

5b-1 wires the pure reconciler (5a) to the real Dawn-derived theme cart: on every cart change the
widget reads the cart, calls `/validate`, and applies the result (add/remove gift lines + apply or
clear the discount code). **No perception UI yet** (progress widget, chooser, decline checkbox are
5b-2). This is the step that finally exercises **drop-below revert** and **non-combinability**
against a real cart/checkout. Testing is manual on the storefront — unit tests don't apply here.

## What the widget keys on (implementation notes)

- **Cart-change detection** (theme = greentee `release`, Dawn-derived):
  - Primary: Dawn **pubsub** — `subscribe("cart-update", …)` (`PUB_SUB_EVENTS.cartUpdate`), published
    by the theme after add/remove/quantity changes.
  - Safety net (theme-agnostic): a `window.fetch` wrapper that re-triggers after any
    `/cart/(add|change|update|clear)` call — except our own (guarded by a `selfMutating` flag).
  - Plus an initial reconcile on load (the cart may already qualify).
  - Debounced 300ms; reconciles are serialized (`running`/`pending`); idempotent via the reconciler
    (no double-add, no loop — our own writes are suppressed and converge to no-ops).
- **Cart reads/writes** (locale-aware via `Shopify.routes.root`):
  - read `GET cart.js`; map each line → `{ id: key, variantId: gid(variant_id), quantity,
appAdded: has _fge_gift property }`.
  - ADD `POST cart/add.js` `{ items: [{ id: <numericVariantId>, quantity: 1, properties: { _fge_gift: "1" } }] }`.
  - REMOVE `POST cart/change.js` `{ id: <lineKey>, quantity: 0 }` (only app-added gift lines).
- **Apply-code mechanism** (the one to confirm at checkout): the **Cart AJAX API** —
  `POST cart/update.js` `{ discount: <code> }` to apply, `{ discount: "" }` to clear (documented;
  changelog 2025-05-21). No navigation; the discount carries into the native checkout. We only call
  it when the code changes.
- **Server stays authoritative:** every line is sent with its `appAdded` claim; the server excludes
  app-added gift lines from the qualifying subtotal, so a gift can't inflate the tier.
- **OR choice (temporary 5b-1 seam):** the chooser UI is 5b-2, so the gift choice for OR tiers is a
  hardcoded default read from the app block's **"Default gift choices"** setting (JSON
  `{ "<tierId>": "<optionId>" }`). Set it from the seed output (see below).

## Prerequisites

- Phase 4 setup done: app installed on greentee-dev, deployed to Vercel with env, campaign seeded
  (see `docs/phase-4-smoke-test.md`). The signed direct `/validate` call passed.
- The theme app extension deployed (`shopify app deploy`) and the **Free Gift** app block added to
  the cart drawer / cart section via the **theme editor**, with **Default gift choices** set to the
  seeded tier-1 OR default, e.g. `{ "<TIER1_ID>": "a" }` (tier-1 id from the seed output; `a` = Ice).
- Build the asset before deploy: `pnpm --filter @free-gift-engine/theme build` (produces
  `assets/free-gift.js`; committed, but rebuild if `src/storefront.ts` or core changes).

## Preview the theme

The Online Store channel is **unpublished** and password-protected. Use the theme preview:

1. In the dev store admin → Online Store → Themes → (theme) → **Preview**, or use a shared preview
   link. Enter the **store password** when prompted (this sets the storefront session cookie).
2. Once past the password page you have an authenticated storefront session; the widget's
   same-origin `fetch('/apps/free-gift/validate')` runs within it.

> **⚠️ Watch this (flag back to me):** open DevTools → Network and watch the POST to
> `/apps/free-gift/validate`. If it returns **200 with our JSON**, great. If it **302-redirects to
> `/password`** or returns the password HTML, the App Proxy isn't reachable on the unpublished
> channel even within preview — in that case **publishing the Online Store channel is required**.
> Publishing also **closes the queued "real storefront → App Proxy forwarding" gate**. Tell me if we
> hit this and I'll wait for your decision on publishing.

## Steps — record expected vs actual

| #   | Action                                                                                                                                    | Expected (observe in the live cart + Network)                                                                                                                                                                               | Actual |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Add **1× Hydrogen (CA$600)** to cart                                                                                                      | Widget POSTs `/validate` → `gift` (tier 1, Ice); then `cart/add.js` adds an **Ice** line with `_fge_gift` property, and `cart/update.js` applies the code. Cart shows Ice as an added line.                                 |        |
| 2   | Open **checkout**                                                                                                                         | The Ice gift line is **$0** (100%-off scoped code applied), matching the verified case-1 behavior.                                                                                                                          |        |
| 3   | **Drop below**: remove Hydrogen (or reduce to < CA$500)                                                                                   | Widget re-runs → `no-gift`/`below-threshold` → `cart/change.js` removes the Ice gift line and `cart/update.js` clears the discount (`discount: ""`). At checkout the gift is gone / no longer $0. **(THE drop-below gate)** |        |
| 4   | **Non-combinability**: with a qualifying cart, try applying a _lower-tier_ gift code in the theme's discount box on top of the active one | Shopify accepts only one product-class code; the lower code does **not** stack a second free gift. Only one gift code is in effect.                                                                                         |        |
| 5   | **No loop / no double-add**: watch Network while idle and during rapid add/remove                                                         | Each settled cart state triggers at most one reconcile; the gift line is added once; our own `cart/*` writes don't recurse.                                                                                                 |        |

### How to observe each

- **Gift added / $0:** the cart drawer/page shows the Ice line; at checkout its line total is $0.
  (5b-2 will badge it "Free gift"; for now it's a normal-looking line that prices to $0 via the code.)
- **Drop-below revert:** after removing the qualifying item, the Ice line disappears and
  `cart/update.js` is called with `discount: ""`; if you had reached checkout first, the gift reverts
  to full price (the discount's base-currency minimum is the backstop even if the code lingered).
- **Non-combinability:** the discounts area of cart/checkout shows a single applied code; a second
  (lower-tier) code is rejected or replaces it — never two free gifts.

## Out of scope (5b-2)

Progress/tier graph, OR + variant chooser UI (product grouping, disabled out-of-stock variant),
decline checkbox UI, polished styling/badges/strikethrough, drawer-render polish, mobile, a11y.

## After 5b-1

- If steps pass: the core thesis is proven against a real cart — proceed to 5b-2 (perception UI).
- Record results; if the password/proxy block (the ⚠️ above) is hit, decide on publishing the
  Online Store channel (which also closes the real-proxy-forwarding gate from Phase 4).
