# Phase 5b-2b — plan (perception polish + runtime resilience)

5b-2a shipped the config endpoint + OR/variant chooser + decline + AND-tier render (all three tiers),
retired the `default_choices` seam, and made cart writes fail-soft. 5b-2b is the perception polish and
the runtime safety net. **Recorded, not yet built.** Pure logic stays unit-tested; DOM/UX is manual.

## A. Runtime gift-add failure handling (NEW — the safety net)

**Why:** "available" diverges across three independent signals — priced (`contextualPricing`),
**published to the Online Store channel**, and in stock — so a gift can look available in the chooser
yet **422 at `/cart/add.js`** (e.g. a sold-out gift the merchant unpublished mid-session, or a
publication lag). The durable fix is 3b (provisioning publishes + availability incorporates
publication — see `docs/phase-5b-reseed.md`); 5b-2b is the **runtime net** for when availability and
add-time truth still diverge. Never leave the shopper thinking a gift was added when it wasn't.

**Current state (audited 5b-2a — the plumbing exists, nothing consumes it):**

- `applyCartPlan` already RETURNS `{ added, removed, failures }`, where each failure is
  `{ kind:'add'|'remove', variantId, status, body }` and the batch-422 path retries per-item so each
  still-failing variant is recorded (`packages/theme-widget/src/cartMutations.ts`). Today the only
  surfacing is a `console.warn` (tagged "perception UX for failures is 5b-2b").
- **`storefront.ts` DISCARDS that result** (`await applyCartPlan(plan, cartPost)` — return value
  unused) and then **unconditionally publishes `cart-update`**, re-rendering as if the add succeeded
  (false-success risk). A non-ok `/validate` and the `gift-unavailable` status also surface nothing.
- The chooser disables options from **static config availability only** (`radio.disabled = !opt.available`
  at render); there is **no** runtime API to disable an option after an add failure, no failure
  callback in `ChooserHandlers` (only `onChoose`/`onDeclineToggle`), and no re-render hook.
- There is **no pending hint / spinner** at all (the `running`/`pending` flags are internal reconcile
  serialization, never user-facing).

**5b-2b must:**

1. **Capture** `applyCartPlan`'s `CartMutationResult` in `reconcileOnce` and branch on non-empty
   `failures` instead of discarding it / unconditionally signalling success.
2. **Map** each failed `variantId` back to its chooser option/tier and, at runtime, **disable that
   option** and show a small **"this gift is currently unavailable"** note — steering the shopper to
   another option. For an **AND tier** where one bundle item fails, surface that the gift could not be
   **fully** added (the bundle is incomplete), not a silent partial.
3. Add a runtime path into the chooser (e.g. a `markUnavailable(variantId)` / failure callback +
   re-render) — today availability is config-time only with no override input.
4. **Pending hint** ("Bringing your free gift…", ~16px spinner, reduced-motion respected): show from
   the `/validate` `gift` result through `cart/add.js` + code apply; **resolve it to the unavailable
   state on failure** (never spin forever, never resolve to a false "added"). The `gift-unavailable`
   status and a non-ok `/validate` must also resolve the hint to unavailable.

## B. Tier progress graph

Server-confirmed state only (the last `/validate` result + the config thresholds): "Spend $X more to
unlock <gift>" and the unlocked state. No optimistic movement / correction jump. The threshold figure
is the presentment `threshold` from `/config` (== `/validate` `appliedThreshold` — the invariant).

## C. Polish

Drawer re-render nudge (`publish('cart-update')`), flicker/race handling, mobile layout, a11y
(roles/labels, keyboard, reduced motion), chooser **placement into the cart drawer** (today it mounts
at `body` end under the backdrop — z-index/placement is 5b-2b), and **fresh-load stale-discount
auto-clear** (seed `lastDiscount` from the cart's applied discount so a stale code is auto-cleared).

## D. Latency reduction (assess, then optimize vs. mask)

One Ice→Dawn switch is **5 serialized round-trips**: `GET cart.js` → `POST /validate` → `cart/change.js`
(remove) → `cart/add.js` (add) → `cart/update.js` (re-apply code). Where the time goes / options:

- `/validate` cost is bimodal — a reused code is a single `findByKey`; a **first-ever** branch switch
  **mints** (extra Shopify calls incl. the exclusion-guard reads) + possible Vercel cold start.
- The code re-apply (`cart/update.js`) is a separate, **inherent** round-trip (one code per OR branch,
  non-combinable).
- Candidates: warm/region-pin `/validate`; **pre-mint both OR branches' codes** at config time so a
  switch never mints on the hot path; consider add-before-remove to overlap; otherwise **mask** with
  the pending hint. Measure real per-call ms on the published storefront before optimizing.

> Not 3b: campaign CRUD UI and wiring `provisionGifts` (incl. channel publish) into campaign
> activation remain 3b. `provisionGifts` is still unwired; gift provisioning is manual until then.
