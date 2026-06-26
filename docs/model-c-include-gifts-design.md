# Design: flip to "gift products INCLUDED in the qualifying collection" (model C)

**Status: Stage 0 DONE. Stage 1 IMPLEMENTED behind `FGE_GIFTS_INCLUDED` (default OFF — inert, all
tests green). NOT yet activated on dev (flag OFF). Turn-on + live checks pending (see end).**

## Premise (validated)

Shopify BXGY separates `customerBuys` (full-price, qualifying) from `customerGets` (the $0 gift) by
**quantity**, splitting the same variant into separate cart lines. The **$0 gets line is excluded from
the buys total**. So the self-qualify leak that today's design prevents by _excluding_ gifts from the
qualifying collection **does not exist** — Shopify's buys/gets split handles it natively. Model C
("a full-price gift purchase counts toward qualification; the same product at $0 does not") is achieved
by **including** gift products in the qualifying collection.

## Stage 0 results (CONFIRMED on dev — isolated delete-after BXGY discounts, dev restored)

1. BXGY excludes the $0 `customerGets` line from the `customerBuys` total — confirmed across
   **product-BOGO, collection-based, and AND-tier (2 gifts)**. No self-qualification, no leak.
2. A **collection-member product bought at FULL price DOES satisfy `customerBuys`** (qualifies via
   membership).
3. **AND-tier `quantity = N`** frees exactly one of EACH of N distinct gift products and excludes all N
   from buys (not N of one).
4. **`customerBuys.items.all = true` is REJECTED for BXGY** ("Items in 'customer buys' must be
   defined"). "Any product qualifies" CANNOT be all-items — it must go through a **collection**.
5. Single-tier minimum gating works (gift stays full price below the threshold). **Deferred to Stage 1
   live:** multi-tier gating, tier-swap, and `appAdded`-vs-line-split — they depend on the widget's
   reconcile + highest-tier-only logic, invisible to isolated discounts.

## Decision: qualifying scope is a CAMPAIGN SETTING (supersedes the earlier Option A/B)

The campaign carries a **qualifying-scope** config:

- **No condition → "anything":** every product qualifies.
- **Tag/condition set →** only products matching that condition qualify.

Both are implemented via a **smart COLLECTION** (finding #4 rules out all-items); only the rule differs:

- "anything" → a smart collection whose rule matches **ALL products** via a tautology, e.g.
  `TAG NOT_EQUALS '<reserved sentinel tag never applied to any product>'` (every product, including
  gifts, lacks the sentinel → all included).
- "condition" → a smart collection matching the merchant's tag, e.g. `TAG EQUALS '<merchant-tag>'`.

**Model-C invariant:** in BOTH cases the qualifying collection must **INCLUDE gift products** so a
full-price gift purchase qualifies. For "anything" that's automatic. For a tag-condition, the gift
products must ALSO satisfy the condition — a constraint to handle when the admin scope setting is built
(out of scope for Stage 1; the real GreenTee case uses the default "anything").

This **supersedes** "exclude gifts via `app:fge_gift` / `TAG NOT_EQUALS app:fge_gift`". Gifts are no
longer excluded; the `app:fge_gift` tag stops being the exclusion mechanism.

`/validate` needs **no change** — `isGift = appAdded && giftVariantSet.has(...)` already counts a
full-price gift purchase (`appAdded=false`) and excludes the app-added $0 unit. The only mismatch was
the discount layer (collection excluded gifts); the scope change above fixes it.

---

## Inventory — what depends on EXCLUSION, and what it becomes

### A. Smart-collection rule — `packages/shopify/src/collections.ts`

- **Now:** rule `TAG NOT_EQUALS app:fge_gift` (L58) → excludes tagged gifts.
- **Becomes:** the rule encodes the campaign scope (above). Default "anything" = `TAG NOT_EQUALS
<sentinel>` (a reserved tag nothing carries) → all products incl. gifts. The `app:fge_gift` tag is no
  longer referenced by the rule.
- **Risk:** confirm the tautological rule is one Shopify accepts and that membership settles (async).

### B. Mint guard — `packages/shopify/src/discounts.ts` + `errors.ts`

- **Now:** `createScopedGiftDiscount` (L136–147) → `giftProductsStillInCollection` → throws
  **`GiftNotExcludedError`** if a gift is still a member. Plus `collectionProductCount` →
  `EmptyQualifyingScopeError` (L129–135).
- **Becomes:** **remove** the exclusion check + `GiftNotExcludedError` (gifts are now supposed to be
  members). **Keep** `EmptyQualifyingScopeError` (a void scope is still a $0 leak).
- **Risk: HIGHEST** — this guard is the entire current safety net. After removal, protection = the
  buys/gets split (Stage 0 confirmed for product/collection/AND). Gate behind a flag; dev-first.

### C. BXGY input — `packages/shopify/src/discounts.ts` `buildBxgyCodeDiscount` (L94)

- **Now / Becomes:** `customerBuys.items.collections=[qualifyingCollectionId]`, amount = minimum;
  `customerGets` = gift variants at 100% off, `discountOnQuantity.quantity = giftVariantIds.length`.
  **Unchanged** — the collection's contents change, not the input. (`all-items` is NOT an option —
  finding #4.)

### D. Provisioning — `apps/admin/src/services/giftLifecycle.ts`

- **Now:** ensure collection → resolve gift products → **tagProductsAsGift** → verify tag →
  **waitForGiftProductsExcluded** → confirm count>0. `reconcileGiftTagsOnTeardown` untags on teardown.
- **Becomes:** gifts must NOT be excluded. Stop tagging gifts; **un-tag** existing gifts (one-time
  migration); drop `waitForGiftProductsExcluded` (optionally wait for **inclusion** before minting).
  Keep ensure-collection + non-empty check; keep the **separate Online-Store publish** step (gift must
  be published to add at $0 — unrelated to the collection; see `gift-availability-three-dimensions`).
  `reconcileGiftTagsOnTeardown` retires (no-op behind the flag for rollback).
- **Risk:** the un-tag migration settles async — mint only after inclusion is confirmed. `write_products`
  becomes used only to un-tag during migration → later droppable (separate, needs reinstall).

### E. `/validate` — `apps/admin/src/validate/service.ts` (L147) + `packages/core/src/cart.ts`

- **NO CHANGE** — already model C (see Decision). `appAdded` is client-supplied, but BXGY is the
  authoritative gate (a fooled `/validate` hands out a code Shopify won't honor below the real minimum).

### F. Reconcile / widget — `packages/theme-widget` + `packages/core/reconcile`

- **Largely unchanged.** The "two-line split" is the buys/gets split. Classification still hinges on the
  `_fge_gift` line property (`isGiftLine`): the app-added $0 unit carries it; a full-price purchase is a
  separate paid line without it → counts. **Stage 1 live** must confirm the property lands so each is
  classified correctly under the split, plus multi-tier gating + tier-swap.

### G. Other

- `collections.ts` L9 comment ("gifts MUST be distinct from qualifying") reverses;
  `composition.ts` L45–52 (`write_products` to tag) reverses; CLAUDE.md BXGY/collection decisions,
  `docs/phase-5b-reseed.md`, the model-C memory. Tests to update: `discounts.test.ts` (guard),
  `collections.test.ts` (rule), `giftLifecycle.test.ts` (tagging/wait/teardown).

---

## Risk summary (leak-focused)

1. **Removing `GiftNotExcludedError` is the one safety-critical change.** Protection becomes the
   buys/gets split alone — Stage 0 confirmed product/collection/AND; multi-tier + tier-swap verified
   live in Stage 1. Gate behind a flag; keep the empty-scope guard; dev-first; fast rollback.
2. **Un-tag migration window** settles async — mint only after inclusion confirmed.
3. **`appAdded` client-trust** — safe because BXGY is the real gate; re-confirm multi-tier minimums live.
4. **Nothing weakens `/validate`** (already model C) — all risk is at the discount/provisioning layer.

## Open questions — status after Stage 0

- RESOLVED: AND-tier (one-of-each, all excluded), collection-member-full-price qualifies, all-items
  rejected (→ collection only), single-tier gating.
- DEFER TO STAGE 1 LIVE: multi-tier gating, tier-swap during remove→code→add, `appAdded` vs the
  buys/gets line split, the tag-condition gift-inclusion constraint (future admin setting).

---

## Staged rollout

- **Stage 0 — experiments. ✅ DONE** (results above; dev restored).
- **Stage 1 — flip on DEV behind a flag.** Detailed plan below.
- **Stage 2 — tests + docs.** Update `discounts.test.ts` / `collections.test.ts` /
  `giftLifecycle.test.ts` to the inclusion model; update CLAUDE.md, `phase-5b-reseed.md`, model-C
  memory. `/validate` tests unchanged.
- **Stage 3 — scope reduction (optional, separate).** If tagging is fully removed, drop `write_products`
  from `GIFT_ENGINE_SCOPES` — requires re-consent/reinstall; do last.
- **Stage 4 — admin qualifying-scope setting (future).** Expose the campaign scope config (anything vs
  tag-condition), with the gift-must-satisfy-condition constraint handled. (Not all-items — finding #4.)

---

## Stage 1 plan (for review — DO NOT implement yet)

**Goal:** on the dev store, behind a flag, make gift products qualify when bought at full price (model
C), with one-command rollback. `/validate` is untouched (already correct).

**Flag:** a single gate `FGE_GIFTS_INCLUDED` (env at the composition root; default OFF = today's
behavior). When OFF, every piece below keeps the current exclusion behavior, so the change is inert
until flipped. (A campaign-level field can replace the env flag in Stage 4.)

**(a) Provisioning + collection rule** — `collections.ts`, `giftLifecycle.ts`, composition root:

- `ensureQualifyingCollection`: when the flag is ON, create/repair the rule as the "anything" tautology
  `TAG NOT_EQUALS <sentinel>` (sentinel = a reserved tag never applied, e.g. `app:fge-nonqualifying`).
  When OFF, keep `TAG NOT_EQUALS app:fge_gift`. (If the collection already exists with the old rule, a
  one-time rule update is needed — confirm `collectionUpdate` ruleSet works, else recreate by handle.)
- `provisionGifts`: when ON, **do not** `tagProductsAsGift`; instead **un-tag** any currently-tagged
  gift products (so no vestigial tag), then `waitForGiftProductsIncluded` (new, symmetric to the old
  wait — poll `hasProduct === true`) before returning ready. Keep ensure-collection + non-empty count.
  Keep the Online-Store publish step unchanged. `reconcileGiftTagsOnTeardown` → no-op when ON.
- **Verify live:** after activation, the qualifying collection contains the gift products
  (`hasProduct=true`); qualifying count > 0.

**(b) Mint guard** — `discounts.ts`:

- `createScopedGiftDiscount`: when ON, **skip** the `giftProductsStillInCollection` / `GiftNotExcludedError`
  check. **Keep** the `collectionProductCount` empty/missing → `EmptyQualifyingScopeError` guard always.
- **Verify live:** a code mints successfully with the gift product as a collection member (would throw
  `GiftNotExcludedError` today).

**(c) `/validate`** — no change. Confirm in the live checks that a full-price gift line
(`appAdded=false`) counts and the app-added $0 line (`appAdded=true`) doesn't.

**(d) Qualifying scope** — Stage 1 ships only the default **"anything"** rule (above). The per-campaign
tag-condition path is Stage 4.

**Live verification on dev (Stage-1 checks):**

1. **Full-price gift qualifies:** add ONLY the gift product at full price ≥ threshold → tier unlocks,
   gift added at $0 (BXGY honors it). (Today: gift excluded → never qualifies.)
2. **$0 gift excluded:** the app-added $0 gift never pushes the tier (the buys/gets split + `isGift`).
3. **Drop-below reverts:** remove qualifying spend below threshold → gift reverts to paid at checkout.
4. **Multi-tier gating:** cross tier-1→tier-2; the tier-2 code's higher minimum is honored (no leak if
   real buys < tier-2 minimum).
5. **Tier-swap:** change qty across a boundary; remove→code→add applies cleanly — no full-price-gift
   window, no double-count, highest-tier-only holds.
6. **`appAdded` vs line split:** buy the gift product full price AND receive a $0 gift; confirm the
   widget classifies the $0 line (carries `_fge_gift`) vs the bought line (no property) — subtotal
   counts the bought unit, excludes the $0 unit, and BXGY zeroes exactly the gift unit.

**Rollback:** flip the flag OFF → next provisioning re-tags gifts, restores the `NOT_EQUALS app:fge_gift`
rule, and the mint guard re-asserts exclusion. Codes are immutable (superseded), so re-minting happens
under the restored scope.

---

## Stage 1 — implemented (behind `FGE_GIFTS_INCLUDED`, default OFF)

What shipped (all gated; OFF is byte-for-byte today's behavior, 338 tests green):

- `collections.ts`: `QUALIFYING_SENTINEL_TAG='app:fge-nonqualifying'`, `EXCLUDE_GIFTS_RULE` /
  `ALL_PRODUCTS_RULE`, `ensureQualifyingCollection(client, { rule?, reconcileExisting? })` (updates an
  existing collection's ruleSet IN PLACE via `collectionUpdate` when `reconcileExisting`), and
  `waitForGiftProductsIncluded` (inclusion poll).
- `discounts.ts`: `ScopedGiftDiscountInput.giftsIncluded?`; when true `createScopedGiftDiscount` SKIPS
  the `GiftNotExcludedError` membership check but KEEPS `EmptyQualifyingScopeError`.
- `giftLifecycle.ts`: `GiftTagGateway.waitForGiftProductsIncluded`; `provisionGifts(..., { giftsIncluded })`
  → un-tag + wait-for-inclusion (no tag/verify) when ON; `reconcileGiftTagsOnTeardown(..., { giftsIncluded })`
  → no-op when ON.
- `shopifyDiscountGateway.ts`: adapter captures `giftsIncluded` and rides it on every mint.
- `composition.ts`: `giftsIncludedFlag()` (reads `FGE_GIFTS_INCLUDED`) + `qualifyingRule()` — the ONE
  source of the flag, threaded into the validate deps (mint + collection rule), the gift-tag gateway
  (rule + reconcile + inclusion wait), and the webhook mint adapter.
- `/validate` + the theme widget: unchanged.

### Turn-on sequence (dev) — DO NOT run until coordinating the live checks

1. Set `FGE_GIFTS_INCLUDED=true` in the admin app's env (Vercel) and redeploy the admin app so the
   runtime reads it. (The theme widget is unchanged — no `shopify app deploy` needed.)
2. Run the migration (flip the rule + un-tag), one of:
   - via the provisioning path: `provisionGifts(await getGiftTagGateway(), <active gift variant ids>,
{ giftsIncluded: true })` — `getGiftTagGateway()` already applies the ON rule + `reconcileExisting`;
     the option drives the un-tag + wait-for-inclusion branch. (Must pass `{ giftsIncluded: true }`.)
   - OR equivalently via Admin GraphQL (mirrors exactly what the code does), matching the Stage-0 flow:
     a. `collectionUpdate(input:{ id:<fge-qualifying id>, ruleSet:{ appliedDisjunctively:false,
rules:[{column:TAG, relation:NOT_EQUALS, condition:"app:fge-nonqualifying"}] }})`
     b. `tagsRemove(id:<each gift product id>, tags:["app:fge_gift"])`
     c. poll `collection(id).hasProduct(id:<gift product>)` until `true` for every gift product.
3. Confirm the qualifying collection now INCLUDES the gift products AND keeps qualifying products
   (count > 0). Then mint (re-validate from the storefront) — the guard is skipped, so a code mints
   with the gift as a member.
4. Run the live checks (1–6 above) with the widget ON.

What to watch: a code mints (no `GiftNotExcludedError`); the gift product shows `hasProduct=true` in the
collection; a full-price gift purchase qualifies; the $0 gift never inflates the tier; multi-tier
minimums hold; no full-price-gift window on tier-swap.

### Rollback

Set `FGE_GIFTS_INCLUDED` OFF (unset / `false`) + redeploy, then re-provision OFF (or via GraphQL:
`collectionUpdate` rule back to `NOT_EQUALS app:fge_gift` + `tagsAdd app:fge_gift` to the gift products

- wait for exclusion). Live codes are immutable; superseding re-mints under the restored exclusion scope.
