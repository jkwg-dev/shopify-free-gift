# Design — Cart & Checkout Validation Function: hard-block a non-qualifying free-gift line

**Status:** VF-0 APPROVED (constraint amended) · **VF-1 BUILT** (`extensions/checkout-validation`, pure +
tested, input query schema-validated) · VF-2 (deploy/activate) + VF-3 (dev verify) PENDING.
**Goal:** an authoritative, server-side, can't-be-bypassed gate that blocks checkout when an FGE
`_fge_gift` line is present but the cart no longer qualifies for that gift — covering the race where the
client-side auto-remove lags, AND **express checkouts (Shop Pay / Apple Pay / Google Pay / PayPal) that
skip the cart page and run no widget JS at all.**

**Approach A empirically VALIDATED on dev:** when the qualifying subtotal drops below a tier minimum,
Shopify drops the BXGY allocation **immediately at the cart level** — a lingering FGE gift line reverts
to **full price** (observed: tier-2 gifts $0 → $729.95 / $749.95 in `/cart.js` the instant the subtotal
fell below the tier-2 minimum), never staying $0. So the Function reading `line.cost.totalAmount > 0`
sees the non-qualifying lingering gift and blocks — **no FX recompute needed.**

---

## 0. ⚠ HARD-CONSTRAINT CONFLICT — read first (needs your explicit sign-off)

CLAUDE.md's **first non-negotiable**: _"NO Shopify Functions anywhere. (Custom-distribution apps with
Functions require Plus.) Pricing and enforcement use the Admin API + native discounts only."_ This task
**reverses** that. So the gating question was the plan/Plus premise — which I verified against live docs:

- **Shopify Functions (incl. Cart & Checkout Validation) = "All plans EXCEPT Shopify Starter."** So on
  **Advanced** they run. (`shopify.dev/.../checkout/technologies` — Functions row.)
- **No Checkout-UI extension / Plus needed for the error to show.** "Errors from validation functions are
  exposed to the Storefront API's Cart object, in themes that use the cart template, and **during
  checkout**." The tutorial activates it on a normal store via **Settings → Checkout → Checkout Rules**
  and the block displays natively. (Checkout _UI_ extensions are Plus — we do **not** need one.)
- A built-in **"Allow all customers to submit checkout"** toggle controls runtime-exception behavior
  (our fail-open lever — §4).
- **Caveat:** _"Merchants that have `checkout.liquid` customizations need to upgrade to Shopify Extensions
  in Checkout to use Function APIs."_ The store must be on **checkout extensibility** (no legacy
  `checkout.liquid`). CLAUDE.md already says "no checkout.liquid," but **confirm the live store is on the
  new checkout** before committing.

**Conclusion:** the "Functions require Plus" premise is **false** for validation functions (and, per the
same docs row, for Functions generally). So the constraint was built on a wrong premise.

**Required decision (yours):** amend CLAUDE.md. Proposed scoped amendment — keep the spirit (native
discounts still do all PRICING), permit a VALIDATION function as a checkout guard:

> _"Pricing/enforcement use Admin API + native discounts only — NO discount/pricing Functions. A Cart &
> Checkout **Validation** Function MAY be used as a checkout-time guard (verified available on Advanced,
> native error display, no Plus). It performs NO pricing."_

**Bigger implication to flag (not chase here):** the same docs row means **"cumulative suppression is
impossible without Plus" is also built on the wrong premise** — a product-discount Function may be
viable on Advanced. That decision should be **separately re-verified**; it's out of scope for this task
but materially changes that earlier conclusion.

_Everything below is the design assuming you approve the amendment. If not, this is shelved and the
native discount minimum (already shipped) remains the only enforcement._

---

## 1. Gift-line identification (analysis)

- **The app's own marker is the truth: the `_fge_gift` line-item property = `'1'`** (`packages/core`
  `GIFT_LINE_PROPERTY = '_fge_gift'`, `reconcile.ts:12`). The widget writes it on auto-add
  (`reconcileGiftLines` → `properties: { _fge_gift: '1' }`) and derives `appAdded` from it on cart load
  (`storefront.ts:74` `isGiftLine`). **Only FGE-added gift lines carry it** — a normal paid line, and a
  **Kite BOGO** line, do not. The Function reads it via the Cart input's `line.attribute(key:"_fge_gift")`
  (cart line attributes == Liquid `line_item.properties`, exposed to Functions).
- **The "dr-…" token** you observed is Shopify's **discount allocation reference** on the line (from the
  applied `/discount/CODE` → `cart/update.js {discount: code}`), visible as `line.discountAllocations`.
  It is NOT our marker and NOT a reliable FGE identifier (Kite BOGO also produces allocations). Use it
  only as a _secondary_ signal (which discount zeroed the line), never the primary id.
- **Primary id rule:** a line is an FGE gift line **iff** `attribute("_fge_gift") == "1"`. This is the
  same server-authoritative marker `/validate` keys on, so the two layers agree by construction. Kite and
  every other discount are invisible to the Function's rule.

## 2. Qualifying subtotal (analysis)

- Today, `packages/core` `computeQualifyingSubtotal(lines, currency)` (`cart.ts:16`) sums **non-gift**
  lines (`line.isGift` excluded) at their real unit prices, in one resolved currency. `/validate` builds
  those `CartLine`s with **server-derived `isGift`** (`appAdded && variant ∈ gift-set`) and authoritative
  prices, never client totals. Stage D scope = "anything" → whole-cart subtotal of non-gift lines.
- **In the Function**, the equivalent is: sum `line.cost` over lines **without** `_fge_gift`. The $0 gift
  lines are excluded by the same marker. BUT — see §3/§5: the recommended design **does not recompute a
  subtotal at all**, sidestepping the multi-currency boundary risk.

## 3. Threshold + multi-currency (analysis) — the crux

- `presentmentThreshold(tier, presentment, base, rate)` (`service.ts:105`) = the **base CAD threshold**
  when presentment == base, else **`ceil(baseThreshold × rate)`** via `convertBaseToPresentmentCeil`,
  where `rate` is **Shopify's own market rate** (`window.Shopify.currency.rate`, passed to `/validate` /
  `/config`). The discount's actual `minimumRequirement.subtotal` is set in **base CAD**, and **Shopify
  converts it per market at checkout**. Invariant: displayed figure == enforced figure.
- **The Function runs at checkout in presentment currency but CANNOT fetch live FX** (Wasm sandbox, no
  network). If it recomputed `ceil(CAD × rate)` it would need the exact same rate Shopify used — which it
  cannot guarantee — so a recompute risks a **boundary mismatch → false block (the worst failure).**
- **Therefore: do NOT recompute the threshold in the Function.** Use Shopify's OWN discount enforcement
  as the threshold authority (the discount minimum is already base-CAD and Shopify already converted +
  enforced it). This makes multi-currency parity **perfect by construction** — there is no second FX path
  to disagree. (This is the key design decision; see §Core logic, Approach A.)

## 4. Eligibility rules (analysis)

`/validate` (`service.ts` `resolveValidate`) + core `resolveActiveGifts`:

- **Highest-unlocked-tier only**: suppression resolves exactly one winning tier; lower tiers suppressed.
- **AND-tier all-or-nothing**: a winning AND tier's gifts are granted together under one BXGY code; the
  backstop loops every required gift.
- **One code per resolved gift-set**; gift codes are **non-combinable** (`productDiscounts:false`) — only
  ONE FGE product-discount can apply to a cart.

The Function must never contradict these. The recommended design inherits them **for free** by deferring
to "is this gift line actually being given free by the FGE discount right now" (below).

---

## Core logic

### Approach A — discount-state gate (RECOMMENDED: FX-free, parity-perfect, no config)

**Rule:** for each cart line with `attribute("_fge_gift") == "1"`, the line **must currently be free**
(post-line-discount cost == 0, given by an FGE discount). If an `_fge_gift` line's post-discount cost is
**> 0**, the cart no longer qualifies for it → **return a validation error that blocks checkout.**

```
for line in cart.lines where line.attribute("_fge_gift") == "1":
    if line.cost.totalAmount.amount > 0:          # not (or no longer) zeroed by the FGE discount
        errors.push({ target: "$.cart",
                      message: "Your cart no longer qualifies for the free gift. Please update your cart." })
```

Why this is correct and superior:

- **It defers the threshold/tier/AND/FX math to Shopify's own discount enforcement.** A gift line is $0
  **iff** the FGE BXGY code applied, which happens **iff** the cart met the base-CAD minimum (Shopify
  converts per market). So "gift is free" == "cart qualifies for that gift" — exactly the invariant, with
  **zero** re-derivation and **zero** FX boundary risk.
- Covers every case the brief lists, without knowing tiers/thresholds:
  - _subtotal dropped below threshold_ → code stops → gift not free → **block**.
  - _gift ≠ highest unlocked tier_ → only one product-discount applies; the stale/lower gift line isn't
    the one being zeroed → not free → **block**.
  - _AND requirement unmet_ → any required AND gift line that isn't free → **block** (both free → allow,
    which is correct: a fully-granted AND tier is legitimate).
- **No metafield config, no campaign-config sync, no staleness** — the Function needs only the constant
  key `"_fge_gift"`. (Edit-while-active supersede, multi-market, new campaigns: all transparent.)
- **Coexists with Kite BOGO** trivially — Kite lines have no `_fge_gift`, so the Function never touches
  them; a Kite-discounted line being $0 is irrelevant (not an FGE gift).

What it intentionally does NOT do: it does not second-guess a gift that Shopify **did** discount (i.e. a
$0 gift that cleared Shopify's own minimum). Catching that would require a stricter independent threshold
= the exact FX-recompute that causes false blocks. The discount minimum already bounds that case; a
sub-cent rounding boundary is not the race and not worth a false-block risk.

### Approach B — recompute tier + threshold in-Function (what the brief literally asked; NOT recommended)

Read the active campaign config from a **metafield**, recompute the presentment qualifying subtotal and
`ceil(CAD × rate)`, resolve the tier, compare. Costs: (a) a metafield config-sync pipeline kept in lockstep
with supersede/activation; (b) **FX parity is unsolvable in-Function** (no live rate) → boundary false
blocks; (c) duplicates `packages/core` logic in Wasm (drift risk). **Recommend A.** B's only theoretical
gain (catching a Shopify-honored-but-"shouldn't-qualify" $0 gift) is precisely the false-block hazard.

---

## Edge cases (required)

- **Multi-currency boundary parity / no false blocks:** _solved by Approach A_ — it performs no FX and no
  threshold recompute, so it cannot disagree with Shopify's own conversion. This is the single biggest
  reason to choose A.
- **Highest-unlocked-tier semantics:** enforced via "only the actually-discounted gift is free" (one
  non-combinable product-discount applies) — a lower/stale gift line is never $0 → blocked.
- **AND tiers:** block any `_fge_gift` line that isn't currently free; a fully-granted AND tier (all lines
  $0) passes. No per-tier knowledge needed.
- **Availability (publication/stock):** **OUT of scope — recommended.** The Function's job is the
  threshold/eligibility race. It can't fetch publication/stock (no network) and blocking an
  already-in-cart $0 gift because it just went out of stock is poor UX. Availability stays the widget +
  `/config` + `/validate` job (Stage E). (Agreeing with your lean.)
- **Fail-open vs fail-closed:** **fail-OPEN on Function runtime exceptions** — set Checkout Rules →
  "Allow all customers to submit checkout". A crashing function must never block _all_ checkouts (the
  worst failure); the native discount minimum remains the revenue backstop. The validation _rule itself_
  still hard-blocks a non-qualifying gift — that's a normal result, not an exception.
- **Coexistence with Kite BOGO / other discounts:** the Function acts only on `_fge_gift` lines; all other
  lines/discounts are untouched. A Kite-only cart can never be blocked by it.
- **Empty / no-gift cart:** no `_fge_gift` lines → no errors → never interferes with normal checkout.
- **Express checkouts (Shop Pay/Apple Pay/etc.):** the validation function **does** run there (docs) —
  this is the _primary_ justification, since the widget JS never runs on those paths, so this is the only
  server-side gate that catches a lingering gift line in express flows.

---

## Staged plan

- **VF-0 — DECISION GATE (you):** approve the CLAUDE.md amendment (§0) + confirm the live store is on
  checkout extensibility (no `checkout.liquid`). No code until this is yes.
- **VF-1 — the Function (Approach A):** a `cart_checkout_validation` extension. Input query selects
  `cart { lines { quantity cost { totalAmount { amount } } attribute(key:"_fge_gift") { value } } }`
  (validate against the `functions_cart_checkout_validation` schema via `validate_graphql_codeblocks`).
  Run logic: emit one `$.cart` error per non-free `_fge_gift` line. Pure + unit-tested (table of carts →
  expected errors). No metafield, no network.
- **VF-2 — deploy + register:** `shopify app deploy` (registers the Function/extension); then **Settings
  → Checkout → Checkout Rules → Add rule → activate** the validation; set **"Allow all customers to submit
  checkout" = ON** (fail-open). Confirm the message renders at checkout AND blocks "Continue to shipping".
- **VF-3 — verify on dev (incl. express):** qualify → gift $0 → checkout allowed; drop below threshold so
  Shopify pulls the discount (gift line lingers, now > $0) → checkout **blocked** with the message; remove
  gift → allowed. Repeat via **Shop Pay** to prove the express path is gated. Multi-currency: repeat in a
  non-base market and confirm **no false block** when legitimately qualifying at the boundary. Confirm a
  **Kite BOGO** cart is never blocked. Replay function executions with `shopify app function replay`.

## Production rollout checklist (additions)

1. Confirm prod store is on **checkout extensibility** (no `checkout.liquid`) — else Function APIs are
   unavailable.
2. `shopify app deploy` to register the validation function on prod.
3. **Settings → Checkout → Checkout Rules:** add + **activate** the validation; set **"Allow all customers
   to submit checkout" = ON** (fail-open on runtime errors).
4. Smoke: a real qualifying cart checks out; a lingering non-qualifying gift line is blocked with the
   customer message; an express (Shop Pay) checkout is gated; a Kite-only cart is unaffected.
5. Note: max 25 validation functions per store (ample headroom).
