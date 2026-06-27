# Phase 3c — campaign activation + provisioning automation (design)

**Status: DESIGN, not built. Awaiting approval. Most side-effect-heavy slice of Phase 3b: activation
triggers provisioning, eager code-minting, and (on replace) teardown — partly async against Shopify.
Builds on Stages A–B (embedded admin, JWT boundary, draft editor) and the shipped multi-currency
derivation (BXGY minimum stays base CAD; thresholds derived at runtime). No new Shopify scope.**

---

## Grounding: the exact current state (from the code)

- **No supported activation path.** `PrismaCampaignRepository` exposes create / update / findById /
  listByShop / updateConfigVersionHash only. `campaignData()` (`db/repositories.ts:118`) **omits
  `active`**, so `create` defaults `@default(false)` and `update` never writes `active`. The
  `CampaignRepository` port (`ports.ts:36`) has no `setActive`. The **only** thing that sets
  `active:true` today is the seed (`scripts/seed-smoke.mjs:114`, direct `prisma.campaign.create`). So
  the live dev campaign is seed-activated; app code cannot activate anything.
- **`/validate` finds the active campaign** via `composition.makeResolveActiveCampaign` →
  `campaigns.find((c) => c.active)`, then **lazy schedule gate**: core `isCampaignActive(schedule, now)`
  inside `resolveActiveGifts` returns inactive outside `[startsAt, endsAt]`. No cron.
- **Minting is LAZY + idempotent.** `resolveValidate` calls `mappingStore.getOrCreate(key, spec)` for
  the **winning** tier's resolved gift-set on each qualifying call. Key = `(campaignId, tierId,
resolvedGiftSetHash, configVersionHash)`. `GiftCodeMappingStore` is concurrency-safe and idempotent
  (reserve → mint → finalize; fail-safe release). Spec: `minimumSubtotal = domainTier.baseThreshold`
  (CAD), `giftVariantIds`, `qualifyingCollectionId`, `startsAt = campaign.startsAt`, `combinesWith`.
- **`provisionGifts` exists but is UNWIRED.** `services/giftLifecycle.ts`: ensure collection → resolve
  gift products → (model-C ON) untag + wait-for-inclusion → confirm collection non-empty →
  `ProvisionResult{ready:true}`; **throws `GiftProvisioningError`** on any broken-scope condition. Only
  the gateway (`composition.getGiftTagGateway`) is built; nothing CALLS provisionGifts. Teardown
  (`reconcileGiftTagsOnTeardown`) is a **NO-OP under inclusion** (gifts are members on purpose).
- **BXGY codes have a start but NO end.** `discounts.ts buildBxgyCodeDiscount` sets `startsAt`, not
  `endsAt`. So a minted code stays redeemable in Shopify indefinitely once its key exists.
- **No Online Store publish step** exists in `packages/shopify` (`publishablePublish` / `write_publications`
  are not implemented). Gifts must already be published to the channel or `/cart/add.js` 422s.

---

## 1. Activation as the hub — order + transaction-like failure handling

Activation is multi-step and partly async; a DB transaction cannot span Shopify calls. So "atomic
enough" is achieved by a **strict order with a single COMMIT POINT (the `active` flip)** plus
**idempotent, inactive-harmless** side effects before it.

### `activateCampaign(shopDomain, id)` order

1. **Preflight (DB read + pure):** load campaign (ownership-checked). Validate it's activatable —
   reuses `validateCampaignInput` (≥1 tier, gifts resolve, thresholds ascending, suppression
   highest-only, schedule well-formed). Reject otherwise (`ActivationError 'invalid-config'`). No side
   effects yet.
2. **Mutual exclusion + overlap (DB read):** find any OTHER active FGE campaign (`findActiveByShop`).
   Two cases drive the rest:
   - **Simple** (none active, or only this one): proceed to a single-flip commit (step 5a).
   - **Replace** (a DIFFERENT campaign A is active): provision + mint THIS campaign first, then swap
     atomically (step 5b). Overlap is expected here → confirm-and-replace (§3).
3. **Provision (Shopify, idempotent, may THROW):** `provisionGifts(gateway, giftVariantIds,
{giftsIncluded})` — ensure the shared collection's model-C rule, un-tag this campaign's gift
   products, wait-for-inclusion, confirm the scope is non-empty. On `GiftProvisioningError` → **ABORT**:
   no mint, no flip, campaign stays inactive (and in the replace case, A stays active). This is the
   "never mint against a broken scope" guard.
4. **Eager-mint (Shopify + DB, idempotent per key):** for EACH tier, for EACH resolved gift-set, call
   `getOrCreate(key, spec)`. AND tier → one set; OR tier → one set **per option** (so an 8-option tier
   mints 8 codes). Spec carries the tier's **CAD** `baseThreshold` as the minimum, plus **`startsAt` AND
   `endsAt` from the campaign schedule** (the new `endsAt`, see §5). Any mint failure → **ABORT** (the
   already-minted codes are inert — campaign not yet live — and reused on retry).
5. **COMMIT (DB, the only "go-live" step):**
   - **5a Simple:** `setActive(id, true)` (single write).
   - **5b Replace:** ONE Prisma `$transaction([ setActive(A, false), setActive(B, true) ])` — the
     **atomic swap**. The DB is never in a 0-active or 2-active state.
6. **Post-commit cleanup (replace only, best-effort):** deactivate A's BXGY codes (Shopify
   `discountCodeDeactivate` + `markInactive`). A is already inactive in the DB, so `/validate` won't
   hand out A's codes even if this lags; A's codes also carry A's own CAD minimums + window. Retryable.

### Why this is "atomic enough"

- **The `active` flip is LAST and single-writed (5a) or single-transaction (5b).** Before it, the
  campaign is invisible to `/validate` (`resolveActiveCampaign` filters `c.active`). So a failure in
  steps 1–4 leaves the system in the **exact pre-activation state** — no half-live campaign, no broken
  scope handed to shoppers.
- **Pre-commit side effects are inactive-harmless + idempotent.** The shared collection rule is the
  same tautology regardless of how many times it's ensured; minted-but-unused codes are reusable, scoped
  to their variants, gated by their CAD minimum AND their start/end window — and never handed out for an
  inactive campaign. A crash between step 4 and step 5 leaves "codes minted + campaign inactive" = safe.
- **The replace case provisions + mints B BEFORE the swap**, so the swap transaction flips A↓/B↑ only
  once B is fully ready. There is never a window with zero active campaigns. (Provisioning B while A is
  still active is safe under model-C: the collection is shared, the rule is identical, and B's codes are
  keyed by B's id — A's scope and codes are untouched.)

### Rollback / mark-failed / retry

- **No explicit rollback needed.** A failure before the commit simply does not flip `active` →
  consistent inactive state. We return a typed `ActivationError{reason}` to the route; the merchant sees
  "activation failed: <reason>" and nothing went live. **No `activationState` column** is added (YAGNI —
  the campaign's own `active=false` + the returned error are the state).
- **Retry is safe end-to-end** because every step is idempotent: re-provision is a no-op if already
  done; `getOrCreate` reuses existing codes; `setActive` is idempotent. Re-invoking `activateCampaign`
  after a partial failure converges.

---

## 2. Mutual exclusion (≤ 1 active FGE campaign) — the atomic swap

- **Scope:** only OUR engine's campaigns. The repo stores only FGE campaigns; other promo types (Kite
  etc.) live entirely in Shopify and are never touched. So "among our campaigns" is automatic.
- **Mechanism:** the swap transaction in step 5b (`$transaction([setActive(A,false),
setActive(B,true)])`) is the invariant's enforcement — the DB can never hold 0 or 2 active FGE rows
  through an activation. A DB-level guarantee, not a read-modify-write race.
- **Deactivate path** (`deactivateCampaign`): `setActive(id, false)` + teardown of that campaign's codes
  (§4). Used both standalone (merchant deactivates) and as the A-side of a replace.
- **Failure handling:** if B's provisioning/minting (steps 3–4) fails, the swap never runs → **A stays
  active** (still serving). If the post-commit teardown of A's codes (step 6) fails, A is already
  inactive (not offered) and the cleanup is retried — never zero or two.

---

## 3. Schedule overlap

- **Where:** server-authoritative, inside `activateCampaign` (and surfaced by the activate route so the
  UI can confirm). Pure window check against other FGE campaigns.
- **Model (locked decision: ≤ 1 active):** because at most one FGE campaign is `active` at a time,
  "overlap" reduces to **"is another FGE campaign already active?"** If yes, activating this one is the
  **replace** case → **confirm-and-replace** (UI: "This will deactivate '<A>' and activate '<B>'.").
  There is no queue of multiple active campaigns, so two windows can never both be live.
- **Interaction with start-now/scheduled:** a scheduled campaign is `active=true` with a future
  `startsAt` (armed but not yet offered). Activating it still counts as the one active campaign, so
  arming a second one replaces the first. (If we ever want a disjoint-window QUEUE — A in Jan, B armed
  for Feb — that's a relaxation of the ≤1-active rule; see Open Questions.)

---

## 4. Provisioning + teardown wiring

- **Invocation point:** `provisionGifts` runs in **step 3** of `activateCampaign` (after preflight/
  exclusion, before mint, before the flip), built from `composition.getGiftTagGateway()`. Pass the
  **activating campaign's** gift variant union (under inclusion, teardown is a no-op so the cross-campaign
  union is unnecessary for correctness; under the legacy exclusion model it would be the union of all
  active campaigns' gifts).
- **What teardown (on deactivate) DOES under model-C inclusion:**
  - **Deactivate that campaign's BXGY codes** — for every active `GiftCodeMapping` of the campaign,
    `discountCodeDeactivate` (Shopify) + `markInactive` (DB). This is the real teardown work.
  - `reconcileGiftTagsOnTeardown` → **no-op** (gifts stay collection members on purpose).
- **What teardown MUST NOT touch:**
  - The shared `fge-qualifying` collection — it persists (shared, idempotent; the next activation reuses
    it). Never delete it.
  - The gifts' tags — do NOT re-tag under inclusion (would re-introduce the old exclusion model and break
    model-C).
  - The OTHER campaign's codes — teardown is scoped to the campaign being deactivated (codes are keyed by
    `campaignId`).
- **Multi-currency compatibility:** minting is unchanged — per tier, CAD `baseThreshold` minimum, Shopify
  converts per market. Provisioning/teardown are currency-agnostic (they touch products/collection/codes,
  not thresholds).

---

## 5. Start-now vs scheduled (cron-free)

- **Start now:** activate immediately; if the editor's `startsAt` is in the future, set `startsAt = now`
  on activate (or the route accepts a `startNow` flag). Provision + eager-mint + flip → live at once
  (`isCampaignActive(now)` true).
- **Schedule for later:** save `active=true` with a FUTURE `startsAt`. **Provision + eager-mint happen AT
  activate-save, NOT deferred.** Lazy `isCampaignActive` gates offering: `/validate` returns inactive
  until `startsAt`, then starts offering automatically — **no cron**.
- **Provision-now for a far-future campaign wastes nothing:** the shared collection rule is idempotent
  (already correct), and minted codes are **inert until their window + a qualifying cart** — and, with
  the `endsAt` addition below, Shopify itself won't honor them outside `[startsAt, endsAt]`.
- **The `endsAt` refinement (REQUIRED, and it's what keeps us cron-free):** today BXGY codes carry only
  `startsAt`, so a code a shopper saved could be redeemed **after** the campaign's `endsAt` (the campaign
  goes un-offered by the lazy gate, but the code itself never expires). Mint each code with **`endsAt =
campaign.endsAt`** so Shopify stops honoring it when the window closes. Then the schedule is enforced
  on BOTH sides with **no cron for activation OR expiry** — the lazy gate stops offering, and Shopify
  stops honoring, at the same instant. (Small additive change: `ScopedGiftDiscountInput.endsAt` +
  `buildBxgyCodeDiscount`; the lazy `/validate` mint path picks it up too.)
- **Assessment: no case forces a cron.** Activation (provision+mint+flip) is eager at activate; offering
  is lazy at `/validate`; expiry is enforced by the code's `endsAt`. The only thing left un-automated is
  _flipping `active=false` in the DB_ after `endsAt` (cosmetic — the campaign is already not offered and
  its codes already expired); a merchant can deactivate it, or a future tidy-up cron can, but nothing
  correctness-critical needs it.

---

## 6. Edit-while-active / supersede — recommendation

**Recommendation: KEEP REFUSING edit-while-active in Stage C (deactivate → edit → re-activate).** Stage
B already throws `ActiveCampaignNotEditableError`; keep it and add a clear **"Deactivate to edit"** flow
in the UI.

- **Why not supersede-while-live now:** superseding a _live_ campaign mints new-hash codes, then
  deactivates old-hash codes. Between persisting the new config and deactivating the old codes there's a
  brief window where a shopper holding an OLD code could still redeem it under the OLD scope/minimum —
  e.g. if the edit RAISED a threshold, a small revenue-leak window. It's bounded and short, but it's a
  real extra failure surface for a single-store app that edits campaigns rarely.
- **Deactivate-to-edit has no overlap window:** deactivating tears down the codes; editing produces a new
  draft; re-activating re-provisions + re-mints under the current `configVersionHash`. The existing
  `updateCampaign` already calls `supersedeStaleDiscounts`, so any stale-hash codes are cleaned on the
  re-activate path.
- **Defer supersede-while-live** to a later enhancement once activation/teardown are proven; if built, it
  must mint-new-before-deactivate-old and eagerly deactivate to minimize the window.

---

## Data-model + code changes (no Prisma migration)

**No schema migration** — `active` already exists on `Campaign`; we only add the code path to set it.

- **`CampaignRepository` port + `PrismaCampaignRepository`:**
  - `setActive(id, active): Promise<void>` — `prisma.campaign.update({where:{id}, data:{active}})`.
  - `findActiveByShop(shopId): Promise<Campaign | null>` — `findFirst({where:{shopId, active:true}, include})`.
  - `setActiveExclusive(activateId, deactivateId | null): Promise<void>` — the atomic swap, wrapping one
    or two `setActive` writes in `prisma.$transaction` (the commit point in §1.5).
- **`packages/shopify` (small, additive):** `ScopedGiftDiscountInput.endsAt?: string` +
  `buildBxgyCodeDiscount` emits `endsAt`. Both mint paths (eager activate, lazy `/validate`) pass
  `campaign.endsAt`.
- **Services (`apps/admin/src`):** `activateCampaign` / `deactivateCampaign` (the hub + teardown);
  an `eagerMintCampaignCodes` helper that enumerates per-tier/per-resolved-set keys + specs and calls
  `getOrCreate`. Reuses `provisionGifts`, `GiftCodeMappingStore`, `supersedeStaleDiscounts`.
- **Routes (JWT, ownership-checked like Stage B):** `POST /api/admin/campaigns/[id]/activate`
  (`{startNow?: boolean, confirmReplace?: boolean}`), `POST /api/admin/campaigns/[id]/deactivate`.
- **Composition:** `activateCampaignForDomain` / `deactivateCampaignForDomain` wiring (resolve shop,
  ownership, build gateway + mapping store + repo, run the hub).
- **No new status column** (failures leave `active=false` + return a typed error).

---

## Staged rollout (smallest safe slice → full)

- **Stage C1 — activation as a supported flip (single campaign), relies on lazy-mint.** Add `setActive`
  - `findActiveByShop`; activate route = preflight + ensure the collection rule (read-only/idempotent) +
    `setActive(true)`; deactivate route = `setActive(false)` + deactivate that campaign's codes. If another
    FGE campaign is already active, **REJECT** ("deactivate the current one first") — no auto-swap yet.
    Codes come from the existing **lazy** `/validate` mint. _Dev-test:_ create a draft in the editor →
    Activate → storefront offers the gift (lazy-minted on first qualifying `/validate`); set a future
    `startsAt` → armed but not offered until the window; Deactivate → no longer offered, codes deactivated.
    Smallest slice that makes activation real + enforces ≤1 active (by rejection).
- **Stage C2 — eager provisioning + eager-mint + window-bounded codes.** Wire `provisionGifts` into
  activate (ABORT-before-flip on `GiftProvisioningError`); eager-mint all per-tier/per-option codes; mint
  with `startsAt` + **`endsAt`**. _Dev-test:_ Activate → the shared collection is provisioned and ALL
  codes appear in the Shopify discounts admin → storefront offers instantly (no first-call latency) →
  force a broken scope (empty collection) and confirm Activate **refuses** and the campaign stays
  inactive → let a campaign's `endsAt` pass and confirm a held code is no longer honored at checkout.
- **Stage C3 — confirm-and-replace swap + full teardown + schedule/UX.** The atomic
  `setActiveExclusive` swap (provision+mint B, then transaction A↓/B↑, then deactivate A's codes);
  confirm-and-replace overlap UX; "Start now" vs "Schedule"; keep edit-while-active **refused** with a
  "Deactivate to edit" button. _Dev-test:_ Activate B while A is live → single atomic swap, A's codes
  deactivate, B live, never zero/two active → try to edit A while active → refused → deactivate → edit →
  re-activate.

---

## Biggest risks

1. **Partial failure during activation (top risk, per the Stage-A flag).** Mitigated by: the `active`
   flip is the LAST step and a single write / single `$transaction`; pre-commit side effects are
   idempotent and inactive-harmless; the replace case provisions + mints B before the swap, so there's
   never a zero-active window. Residual: A's post-commit code-teardown can lag (A inactive but a few
   codes briefly live) — bounded (A not offered; codes carry their own CAD minimum + window) and retried.
2. **Eager-mint latency for many-option OR tiers.** The real campaign's 8-hat tier mints **8** codes;
   2/2/8 ⇒ ~11 `discountCodeBxgyCreate` calls per activation. On a Vercel serverless function this could
   approach the timeout if serial. Mitigations: bounded-parallel minting, or eager-mint AND tiers + the
   first OR option and lazy-mint the rest, or an async/background activation. **Open question** below.
3. **Post-`endsAt` redemption** if codes are minted without `endsAt` — a held code stays redeemable after
   the campaign ends. The design **requires** adding `endsAt` (§5) to close this and stay cron-free.
4. **No Online Store publish step.** Provisioning does not publish gifts to the sales channel; an
   unpublished gift 422s at `/cart/add.js`. Stage C **defers publish to Stage E** (channel policy) and
   assumes gifts are pre-published; `/validate`'s `gift-unavailable` + the widget degrade gracefully if
   not. Flag for any NEW campaign whose gifts aren't yet published.
5. **`write_products` dependency.** `provisionGifts` needs `write_products` (un-tag under inclusion).
   Granted on dev; a missing grant throws `tag-not-applied` and aborts activation (correctly).
6. **Shared collection during the swap.** Provisioning B mutates the shared collection rule (idempotent,
   same tautology) while A is active — safe under model-C, but the empty-scope guard must hold throughout
   (it does: `provisionGifts` confirms non-empty before returning).

---

## Open questions (resolve / verify on dev before building)

1. **Eager-mint all OR options at activate, or eager AND-tiers + first option and lazy the rest?**
   (Instant-offer vs activation latency / serverless timeout for the 8-hat tier.) Recommend: bounded-
   parallel eager-mint all; measure the 2/2/8 activation round-trip on dev and fall back to partial-eager
   if it's slow.
2. **Add `endsAt` to minted BXGY codes (= `campaign.endsAt`)?** Recommend YES (closes the post-end
   redemption hole, keeps us cron-free). Verify on dev that Shopify honors BXGY `endsAt` as expected.
3. **Confirm the ≤ 1-active model (no disjoint-window queue).** Recommend YES (matches the locked
   decision); a queue is a future relaxation.
4. **Confirm edit-while-active stays REFUSED (deactivate-to-edit) for Stage C; supersede-while-live
   deferred.** Recommend YES.
5. **Online Store publish — defer to Stage E (pre-published gifts) or fold a publish step into C2
   provisioning?** Folding it in needs `write_publications` + `publishablePublish` (new scope →
   reinstall). Recommend defer to E; flag the pre-publish requirement at activation.
6. **Synchronous activate route vs async/background job**, given (1)'s mint latency vs the Vercel
   function timeout. Recommend sync if bounded-parallel mint of the 2/2/8 set measures fast on dev;
   otherwise an async activation with a "provisioning…" state.
