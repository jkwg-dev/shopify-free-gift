# Cart-drawer two-group grouping + BXGY split-line defects — design

**Status:** DESIGN ONLY — no code. Last build for the first campaign. Grounded by a parallel code
analysis + an adversarial review; the 5 review findings are folded in (marked ⓥ).

## 0. Scope (precise — not "pure presentation")

Widget/storefront layer only (`packages/theme-widget` + its injected DOM/CSS). It does **NOT** change
cart line-item semantics, the reconcile plan (`packages/core reconcileGiftLines`), minting, model-C /
qualifying-scope, `/config`, `/validate`, the issued discounts, or the Rust VF. It **reads** `cart.js`
(existing), transforms theme-rendered DOM, and issues **exactly one new class of cart write**: a
**user-initiated** absolute-quantity edit on a _buy_ line (defect #2). That write is a cart mutation —
so this is "presentation + one user write," NOT "no writes" (ⓥ5). It is safe because `reconcileGiftLines`
provably writes **only** `_fge_gift` (appAdded) lines and gift-variant adds — it has **no** operation
that touches a buy line (`core/src/reconcile.ts:66-109`), so a user buy edit is never reverted. JS/TS
stays green; all new logic is pure, unit-tested functions + a thin DOM adapter.

## 1. Where lines render today (confirmed)

The widget is an **app embed** (`free-gift-embed.liquid`, site-wide) that loads `free-gift.js` and
injects exactly **two** owned divs per cart surface — a progress **stepper** and the **chooser**
(`cartSections.ts mountOne`). **The theme (Dawn) renders the entire line list, prices, qty steppers,
remove buttons, and discount labels.** The widget owns no line node. On every cart change Dawn
re-renders its drawer/cart HTML (its own Section Rendering), detaching the widget's nodes; the widget
re-attaches them via a per-surface `MutationObserver`, disconnecting around its own writes.

**Approach — Option B+ (in-place DOM transform of the theme's rendered lines), with bounded ownership.**
On each re-attach pass, read `cart.js`, correlate each line to its theme DOM node (by line `key` /
`variant_id`), then: reparent gift nodes into a widget-created **gets** group and non-gift nodes into a
**buys** group; display-merge same-variant buy nodes into one row; make the gets group read-only;
suppress our discount-code label. **ⓥ1/ⓥ2 corrections:**

- This is **not** a free ride on the existing observer — it requires a **new transform hook** invoked
  from `cartSections` (expose it from `mountOne`'s observer, or add a second observer). Net-new code,
  still presentation-layer.
- For the merged buy row, the widget **owns and overwrites the qty + line-price text** (it always shows
  the `cart.js`-derived totals, not Dawn's per-split number). This bounded ownership is what makes
  defect #2 deterministic (§E). It does NOT re-implement the rest of Dawn's line markup.
- **Fail-open:** if nodes can't be correlated (theme update / custom theme / selector drift), leave the
  theme's untouched single mixed list — never mis-group, hide a real line, or neutralize a wrong control
  (mirrors the strict/lenient anchor fallbacks already in `planInsertions`).

Rejected: Option A (widget renders its own full line list, hides the theme's) — a large ownership grab,
diverges from theme styling, worse portability.

No new `/config` field is needed — grouping/labels derive from `cart.js` + the already-known applied
code (`lastResult.code`) + the resolved gift variants (`lastResult.giftVariantIds` / config tiers).
The widget must additionally read these `cart.js` line fields it doesn't map today (presentation-only;
the engine's `CartLineView` is unchanged): `final_line_price`, `original_line_price`, `final_price`,
and `line_level_discount_allocations[]` (with `discount_application.title`).

## 2. Classification — allocation-primary, scoped to OUR discount (ⓥ4)

The headline "gets iff `_fge_gift=="1"`" is correct in the common case but must defer to the **$0
allocation** because of accepted **issue #6**: under model-C the same gift product can be bought
full-price AND received free, and Shopify may put the $0 on the _unmarked_ split while `_fge_gift`
lands on the _full-price_ split. Property-only grouping would then file a paid line under gets and the
free line under buys. Authoritative rule (extract in this order):

1. **GETS** = lines zeroed by **OUR** BXGY discount: `final_line_price === 0` **AND** the line's
   `line_level_discount_allocations[].discount_application.title === ourCode` (**ⓥ4: scope to our code,
   not bare $0** — so a stacked order-level promo or a Kite BXGY that happens to zero a line is never
   misread as our gift). An AND tier zeroes multiple gift variants under one code → all are gets.
2. **LINGERING** (→ gets group, "pending" state, §H) = `_fge_gift=="1"` AND not in gets AND **no
   same-variant gets sibling** — a gift that should be free but isn't yet. The "no $0 sibling" guard is
   what keeps an issue-#6 paid unit (which _does_ have a $0 sibling) OUT of lingering.
3. **BUYS** = everything else, merged by variant (§C).

`_fge_gift` is thus used only to (a) seed the engine's subtotal-exclusion `appAdded` (unchanged) and
(b) flag a not-yet-free gift. Because gets/lingering are extracted **first**, the buys-merge only ever
sums lines that are neither → it can never absorb the gift, including the issue-#6 overlap. Confirmed
correct for highest-tier-only (one marked variant) and AND (both marked, both zeroed under one code).

## 3. Defect #1 — same-variant BUY merge (display)

In the buys group, group remaining lines by `variant_id`. Per group: displayed **qty Q** = Σ line
quantities; displayed **price** = Σ `final_line_price` (+ Σ `original_line_price` for any strikethrough
Dawn shows); **canonical key K1** = first in cart order, **siblings K2..Kn** retained for the control.
Render **one** row (the widget owns its qty/price text per Option B+); remove the sibling nodes. `n>1`
only when Shopify BXGY-split the variant. Pure presentation — Shopify may stay split underneath.

## 4. Defect #2 — merged controls on a Shopify-split variant (the key risk)

Controls compute an **absolute** target T (never a delta): **+** → `T=Q+1`; **−** → `T=Q−1` (T=0 ⇒
delete); **delete** → `T=0` (removes the whole merged qty).

**The write — ONE atomic, line-keyed `cart/update.js`:**

```
{ updates: { K1: T, K2: 0, …, Kn: 0 } }     // delete ⇒ every key → 0
```

A single recalculation resolves all keys against the pre-update state at once. **Do NOT** issue
sequential `cart/change.js` per key — the first re-splits/re-allocates and invalidates the rest; that
sequential split-key hazard _is_ defect #2. (`n==1` may reuse the existing `cart/change.js {id:K1,
quantity:T}` path.) Keep the write in `cartMutations` with the injected `post` (DOM-free, unit-testable).

**ⓥ3 write-safety rule:** the `updates` map **only ever writes keys of lines WITHOUT the `_fge_gift`
marker.** A marked line is reconcile-owned and is never zeroed by a buy control. This prevents the
issue-#6 orphan the review found (a merged delete zeroing a mis-migrated marker line, after which
reconcile — which only manages marked lines — can no longer reclaim the unmarked $0 sibling). In the
rare overlap, the buys row still _displays_ the full-price unit but its control operates only on the
unmarked units; the VF blocks checkout if any gift ends non-free regardless. (Narrow, documented.)

**ⓥ1 determinism (the fix):** a raw `cart/update.js` does **not** trigger Dawn to re-render its line
HTML, so we cannot rely on the theme redrawing the number. Determinism comes from the widget **owning
the merged row's qty/price text** (Option B+): on a click it **optimistically sets the row to T**
immediately, then the post-reconcile `cart.js` read re-derives the merged Q (== T) and reconfirms. The
shown number is always the widget's cart-derived value, never Dawn's stale per-split node — so it always
matches the user action regardless of how Shopify re-splits.

## 5. Defect #2 — race with reconcile (user edits always win)

Provably no revert: `reconcileGiftLines` writes only marked/gift lines, so the merged-buy control is the
**only** writer of buy lines. A mid-flight re-split from reconcile applying/clearing the code is cosmetic
(keys/grouping change, not the variant's total) and invisible under absolute semantics + re-merge.
Sequencing (reuses the existing single-flight `schedule`, `selfMutating` echo-suppression, observer
disconnect):

1. Compute T from the freshest rendered merged qty (debounce/disable the stepper during an in-flight
   write so compounding clicks don't compute T off a stale base — reuse `beginGiftPending`).
2. `await` any in-flight reconcile (the `running`/`pending` lock) — no two cart writes overlap.
3. `selfMutating=true` → the one atomic absolute write → `await`.
4. Optimistically set the merged row to T.
5. `selfMutating=false` → **explicitly** `schedule(config)` (a raw `cart/update.js` fires no Dawn pubsub
   and is self-suppressed by the fetch patch, so it won't auto-trigger reconcile).
6. Reconcile re-reads (sees T), re-resolves tier, mutates only gifts + code; the grouped view
   re-renders from the post-reconcile cart where the variant sums to T.

## 6. Defect #3 — read-only gift group + suppress the code label

- **Read-only gets group:** hide/neutralize the theme's stepper/+/−/remove on each gift node (re-applied
  every re-attach, since Dawn redraws them). The widget issues **no** cart write for a gift line.
- **Suppress the raw code label:** the label (e.g. `cVI_d1TGQRtyMRf6ANKS70WC`) is painted by **Dawn**
  from `discount_allocations[].discount_application.title` (and the cart-level discount pill); for a code
  discount the title _is_ the code. On each re-attach, find the theme label nodes whose text equals
  **our** code (known via `lastResult.code`) and hide/rewrite them to **"Free gift"**. **Strictly scope
  to our code** so a merchant's other promo (Kite BOGO) is untouched.

## 7. Layout, lingering, no-gift, Kite

- **Order/headers:** **buys group first** ("Your purchase"), **gets group second** ("Your free gift" /
  "Your free gifts" for AND). Keep Dawn's native **$0 + strikethrough** on gift lines; add a small "Free
  gift" badge where the code label was (reuse `.fge-card__status.is-unlocked` tokens).
- **AND tier:** all zeroed gift variants as rows under **one** "Your free gifts" header.
- **Lingering gift (§2.2):** render in gets as **"Free gift — pending"** (price still showing, not
  silently FREE), using the existing pending affordance. Pure display signal — it does NOT add/remove/
  re-price; reconcile + the code converge it. The VF blocks checkout while it's >$0.
- **No-gift state:** show only the buys list, **no "Your purchase" header** (an orphan header reads
  oddly with nothing to contrast), and rely on the existing **stepper** as the teaser ("Spend $X more
  to unlock…"). No second in-list teaser. (Recommended — confirm in §10.)
- **Kite BOGO:** no `_fge_gift`, never $0-by-our-code → stays in buys, keeps its own label + controls,
  untouched.

## 8. The biggest risk

**Theme-DOM correlation fragility** (cart.js key/variant ↔ Dawn line node + Dawn selectors), re-applied
inside the observer without a loop/flicker. Mitigation: **fail-open to the untouched theme list** when
correlation/selectors break (§1). Secondary: allocation-misclassification — mitigated by ⓥ4 (gets must
be $0 **via our code**, not bare $0).

## 9. Staged plan (smallest safe slice first)

- **Stage 0 — data + pure logic (no UI):** extend the internal cart read (`final_line_price`,
  `original_line_price`, `final_price`, `line_level_discount_allocations[]`). Add unit-tested pure
  functions: `classifyLines(lines, ourCode, giftVariantIds) → {gets, buys, lingering}` (§2) and
  `mergeBuysByVariant(buys) → rows{variantId, totalQty, totalPrice, writableKeys[], displayKeys[]}`
  (§3, writableKeys excludes marked lines per ⓥ3). Locks the contract; zero risk.
- **Stage 1 — read-only grouping + label suppression (no new writes):** the transform hook — reparent
  into buys/gets, merge buy rows (display only), read-only gets, suppress our code label. Delivers
  defects #1 and #3 with zero cart mutations. (Temporarily disable the buy stepper on split rows so it
  never feels broken before Stage 2 — confirm §10.8.)
- **Stage 2 — merged-control writes (defect #2):** wire +/−/delete → the atomic `cart/update.js`
  through `cartMutations`, with §5 sequencing + the widget-owned merged-row qty/price display + the
  debounce/disable affordance.
- **Stage 3 — lingering "pending" + no-gift polish (§7).**
- **Stage 4 — graceful-degradation hardening + tests across both surfaces (drawer + `/cart`).**

## 10. Product/copy decisions to confirm

1. **Headers/order:** "Your purchase" (top) → "Your free gift(s)" (bottom)? Wording + the gift-group
   sub-label "Unlocked · added free"?
2. **Layout density:** two labeled sections in the same list (recommended) vs. a heavier card/divider
   around the gift group.
3. **No-gift teaser:** no in-list teaser + suppress the "Your purchase" header when there's no gift
   (recommended) vs. always show both headers.
4. **Lingering gift:** "Free gift — pending" in gets (recommended) vs. leave as a priced line until
   reconcile zeroes it.
5. **Delete behavior:** delete removes the **entire** merged quantity for the variant (recommended) —
   and should "−" at qty 1 delete, or stop at 1?
6. **Code-label replacement:** "Free gift" vs. hide entirely.
7. **AND-tier:** all gifts under one "Your free gifts" header (recommended).
8. **Stage-1 interim:** disable the buy stepper on split rows until Stage 2 ships (recommended) vs.
   leave it as-is.

## M. RESOLVED — issue-#6 × delete residual (Stage 2 controllable-units model)

**The residual:** when a gift product is BOTH bought full-price and received free, the `_fge_gift`
marker can migrate onto a **buy** (full-price) line (CLAUDE.md issue #6 / §M.1 above). ⓥ3 forbids the
buy control from writing that marked key. So if a marked unit were folded into the interactive merged
row's _displayed_ quantity but the control couldn't write it, a "−"/"delete" could compute a target the
write can't reach — a silent no-op (control shows qty 2 → user clicks delete → only the unmarked unit
clears → row still shows the marked unit at qty 1). Display and control would disagree.

**Decision — display and control over the SAME set.** The interactive merged buy row reflects ONLY the
**controllable** (unmarked) units of the variant:

- `controllableQuantity` / `controllableFinalPrice` / `controllableOriginalPrice` sum only the unmarked
  lines. The +/−/delete stepper drives that quantity, the row's price shows that sum, and `writableKeys`
  contains only those (unmarked) keys — so a control's target is always reachable; it can never no-op.
- A **marked** overlap unit in the buy group is excluded from the interactive row and surfaced as a
  **read-only** line (`readOnlyIndexes`) — price shown, no controls — visually distinct so the shopper
  sees their extra full-price unit but the widget never writes it (reconcile owns it).
- If a variant's entire buy group is marked (`controllableQuantity == 0`, `interactiveIndex == null`),
  there is **no** interactive row — just the read-only line(s).
- **Common case (no marked unit in any buy group): `controllable == total`**, so +/−/delete fully drive
  the whole merged quantity exactly as §4 describes. The split is invisible to the shopper.

The VF still hard-blocks checkout if any `_fge_gift` line ends non-free, so this presentation choice
carries no revenue risk. This supersedes the looser §M.1 wording ("the buys row still displays the
full-price unit but its control operates only on the unmarked units"): the displayed qty/price of the
**interactive** row are the controllable units only; the marked unit is shown on its own read-only line,
not folded into the interactive row.
