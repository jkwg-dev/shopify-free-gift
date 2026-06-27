# Phase 3b — admin design (UI + scope setting + provisioning automation + scheduling + channel policy)

**Status: decisions LOCKED; Stages A–B SHIPPED. Stage A = embedded shell + App Bridge session-token
boundary + read-only campaign list. Stage B = campaign + tier EDITOR (create/edit INACTIVE drafts;
JWT on writes; pure tier-shape validation; server-side currency-exponent boundary for admin entry).
Stages C–E designed, not built. Decisions also recorded in CLAUDE.md ("Decision: Phase 3b admin").**

## Locked decisions (2026-06-26)

1. **One active FGE campaign at a time** (mutual exclusion), server-enforced — applies to our engine's
   campaigns only. Activate → deactivate the other (+ teardown); reject overlapping schedule windows
   (confirm-and-replace). Build in Stage B/C.
2. **Single shared qualifying collection** (one active campaign → one collection; no per-campaign).
3. **`combinesWith.productDiscounts:false` kept** (free gift not stacking with another product
   discount). Prod launch-gate check: Kite "BOGO 50%" (also BXGY) precedence when both qualify — verify
   in production. Future: per-campaign "allow combining" toggle (default off).
4. **Channel scope = `read_products` / `publishedOnPublication`** — NO `read_product_listings`, no
   reinstall (Q1 resolved on dev). Channel policy itself is Stage E.
5. **Scheduling LAZY** (no cron); **provision + eager-mint at activate** (Stage C).

## Stage A — what shipped

- `shopify.app.toml` `embedded = true`.
- App Bridge (CDN script + `shopify-api-key` meta in `app/layout.tsx`) + Polaris (`AppProvider` in
  `app/Providers.tsx`; deps added: `@shopify/polaris`, `react`, `react-dom`). `tsconfig` gains
  jsx/DOM-lib (Next then sets jsx→preserve + its plugin on build).
- **JWT boundary**: `src/security/sessionToken.ts` (`verifySessionToken`, already existed + tested) +
  new `src/admin/session.ts` `shopFromBearer` (Bearer parse → verify → dest→shop) + tests.
- **Read-only list**: `app/api/admin/campaigns/route.ts` (GET, JWT-verified → `listCampaignsByDomain`
  → `campaignListRows`), the pure `src/admin/campaignList.ts` view-model (+tests), and the embedded
  page (`app/page.tsx` reusing the install gate → `app/CampaignListClient.tsx`).
- **CSP**: `middleware.ts` sets `frame-ancestors` for `/` only — App-Proxy/OAuth/webhooks/admin-API
  routes are not framed and untouched.
- Composition: `getAdminSessionConfig()` + `listCampaignsByDomain()`. No data-model change.
- App-Proxy `/validate` + `/config` (HMAC) and the storefront widget are UNCHANGED — verified in the
  build output (both routes still present) and the green test suite.

> NOTE — `@shopify/polaris@13` lists a `react@^18` peer but we run `react@19` (install warns, builds
> clean). Verify the rendered UI in the dev admin; if Polaris misbehaves on React 19, pin React 18 or
> wait for Polaris' React-19 support.

## Current state (grounded in the code)

- **Admin app is headless.** `apps/admin/app/` has only: `api/auth` (OAuth begin), `api/auth/callback`
  (exchange + persist offline token), `api/webhooks` (uninstall + compliance ack), `apps/free-gift/
config` + `validate` (App Proxy, storefront), and `/` (install-state redirect, "NOT the Phase 3b
  embedded admin UI"). **No Polaris, no App Bridge** (not in `apps/admin/package.json`); `shopify.app.toml`
  has `embedded = false`. There is **no HTTP path to create/activate a campaign**.
- **Campaign data layer exists** (`PrismaCampaignRepository`): `create(shopId, NewCampaignInput)`,
  `update(id, input)` (replaces tiers wholesale; "live discount codes are never touched here —
  superseding is the caller's separate step"), `findById`, `listByShop`, `updateConfigVersionHash`.
  `NewCampaignInput = Omit<Campaign, 'id'|'shopId'|'active'|'configVersionHash'|'tiers'> + tiers` — note
  **`active` is NOT settable through the repo** (schema `active Boolean @default(false)`). Today the only
  thing that sets `active=true` is `scripts/seed-smoke.mjs` writing the DB directly. → **activation has
  no supported code path yet.**
- **Scheduling already works, lazily.** `Campaign` has `startsAt/endsAt/displayTimezone` (UTC instants;
  tz for rendering only). Core `isCampaignActive(schedule, now)` is checked inside `resolveActiveGifts`
  at `/validate` time (test: "inactive outside the schedule window"). So "active now" = `active===true`
  **AND** `now ∈ [startsAt, endsAt]`. No cron exists or is needed for activation.
- **Provisioning logic exists but is UNWIRED.** `provisionGifts` (giftLifecycle.ts) has both paths
  (exclude / model-C include) and the `getGiftTagGateway` wiring, but **nothing calls it** — provisioning
  is run by hand today. `reconcileGiftTagsOnTeardown` likewise.
- **Availability today** (`resolveCampaignConfig`): a gift option's `available` = `availableForSale`
  (from `priceVariants`/contextualPricing) AND the variant resolved to a product. It does **NOT** check
  Online-Store **channel publication** — which is the gap behind the channel policy (#5) and the
  `gift-availability-three-dimensions` memory (an unpublished in-stock gift returns `availableForSale:true`
  but 422s at `cart/add`).
- **Scopes:** `read_products, write_products, write_discounts, read_discounts`. `embedded=false`.

So Phase 3b is mostly **greenfield UI + wiring**, not new business logic: the repo, scheduling, and
provisioning logic already exist.

---

## The five concerns

### 1. Admin UI (Polaris + App Bridge, embedded)

- **New:** add `@shopify/polaris` + `@shopify/app-bridge(-react)`; set `embedded = true` in the toml;
  add embedded Next routes under `app/(admin)/...` rendering Polaris. Every embedded **API** call must
  verify the **App Bridge session token (HS256 JWT, `SHOPIFY_API_SECRET`)** — CLAUDE.md requires it and
  it does **not** exist yet (the only auth today is OAuth + App-Proxy HMAC). This is a real new security
  boundary.
- **Screens:** campaign **list** (`listByShop`) → campaign **editor** (name, schedule dates +
  `displayTimezone`, decline toggle, suppression FIXED to `highest-only` — never expose cumulative,
  CLAUDE.md) → **tier editor** (per-tier base threshold, gift kind OR/AND, gift variant picker, per-market
  threshold table). Gift variant picker = a `read_products` variant search (reuse the Admin client). All
  UI calls core/shopify; holds no business logic (CLAUDE.md).
- **Reuses:** the repository (CRUD) + `resolvedGiftSetHash`/`configVersionHash` from core for the
  supersede decision on edit.

### 2. Qualifying-scope setting (model-C Stage 4)

- **Campaign field** `qualifyingScope`: null/empty → **"anything"**; a tag/condition → only matching
  products qualify. Both realized as the smart collection (BXGY rejects all-items — confirmed): "anything"
  = `ALL_PRODUCTS_RULE` (`TAG NOT_EQUALS app:fge-nonqualifying`); condition = `TAG EQUALS <tag>`.
- **Model-C invariant to surface in the admin:** for a tag-condition, the **gift products must also carry
  the tag** (else a full-price gift purchase wouldn't qualify). The editor must either (a) auto-add the
  condition tag to gift products during provisioning, or (b) warn/block if any gift product lacks it.
  Recommend (b) warn at save + (a) auto-tag at provision, with the warning as the safety net.
- Wires to the existing `ensureQualifyingCollection({ rule, reconcileExisting })` — extend the rule
  selection from the binary flag to the campaign's scope (the flag stays as the global kill-switch).

### 3. Provisioning automation

- **Invoke `provisionGifts` on activate** (the side-effect point), passing the campaign's active gift
  variant union + the scope rule. Today it's manual. On **deactivate/teardown**, call
  `reconcileGiftTagsOnTeardown` + deactivate the campaign's live codes.
- **Provision at SAVE/ACTIVATE, never lazily** (it tags/flips the collection + waits for async membership;
  it can hard-fail). The activation flow must: persist `active`, run `provisionGifts` (hard-fails →
  surface the error and do NOT leave a half-activated campaign minting against a broken scope), then it's
  safe to mint. **Mint timing:** today codes mint lazily on first `/validate`; recommend **eager-mint at
  activate** so provisioning + mint failures surface in the admin, not to the first shopper (lazy stays a
  fallback).
- **Edit-while-active = supersede:** `repo.update` deliberately doesn't touch codes. The activate/save
  flow must, on a scope/threshold/gift-set change (detected via `configVersionHash`), deactivate stale
  codes and re-mint (CLAUDE.md "supersede, don't edit").

### 4. Scheduling

- **Recommend LAZY (no cron)** — it already works: store `startsAt/endsAt`; `resolveActiveGifts` gates by
  the window at `/validate`/`/config`. The admin just edits `active` + dates. Exact-second activation is
  not needed (a gift appearing within one `/validate` round-trip of `startsAt` is fine; the discount's
  own `startsAt` is the checkout backstop).
- **Provisioning vs schedule:** provision at **save/activate** (eager, once), NOT at `startsAt`. The
  window then gates _offering_ the gift lazily — provisioning is already done, so when `startsAt` passes
  the gift simply starts being offered. Caveat to decide: if a merchant schedules far in the future,
  provisioning runs now (tags/flips the shared collection now); for the single-store/"anything" case
  that's harmless. (A future cron is only needed if provisioning must be deferred to `startsAt`.)

### 5. Channel / availability policy

- **Policy:** never auto-publish gifts; a gift **not on the Online Store channel → excluded** from
  candidates; an **unlisted** gift → treat as **out-of-stock**; a gift that **drops off-channel after
  being added** → removed **customer-side**, shown **opacity-dimmed admin-side** with **explicit
  admin removal** (and can re-apply if it returns).
- **Where each part lives:**
  - **Customer-side filtering** (the automatic part): extend `resolveCampaignConfig`'s `available` (and
    `/validate`'s `gift-unavailable` backstop) to include **channel publication**, per
    `gift-availability-three-dimensions`. An off-channel/unlisted gift → `available:false` → the chooser
    hides/disables it and the widget never offers it (the existing OOS path already does the rest).
  - **Admin-side** (the presentation + lifecycle): the editor shows each gift's channel status; an
    off-channel gift is **dimmed** with an **explicit "remove" action** (we do NOT auto-delete it from
    the campaign — it can re-apply when it returns).
- **Scope — KEY DECISION (see open questions):** the user specified `read_product_listings`. BUT the
  `gift-availability-three-dimensions` finding is that **`Product.publishedOnPublication(<online-store
publication>)` reads channel publication with `read_products` (NO new scope)**. `read_product_listings`
  is the legacy ProductListing API. **Recommend:** if `publishedOnPublication` distinguishes the states we
  need (on-channel vs unlisted), use it → **no scope change, no reinstall**. Only add
  `read_product_listings` if the ProductListing resource is genuinely required for the **unlisted**
  sub-state — verify on dev first.

---

## How they interlock

- **Activate** is the hub: it persists `active`, picks the **scope rule** (#2), runs **provisioning**
  (#3) for that rule + the gift set, and (eager) mints. **Scheduling** (#4) gates _offering_ lazily after
  that. **Channel policy** (#5) filters candidates at runtime and surfaces status in the editor.
- **Edit** flows through `configVersionHash` → supersede (deactivate + re-mint) when scope/threshold/
  gift-set changed; schedule/FX/decline edits don't churn codes (minting.ts already excludes them).
- The **`FGE_GIFTS_INCLUDED` flag** stays the global model-C kill-switch; the per-campaign scope (#2) is
  the finer control layered on top once the flag is permanently ON.

## Data-model changes

- `Campaign.qualifyingScope` — nullable (null = "anything"; a string tag = condition). Migration:
  `prisma migrate` (committed, with `DIRECT_URL`); default null = today's "anything" behavior.
- **Activation path:** add `CampaignRepository.setActive(id, boolean)` (activation is a distinct,
  side-effectful action — cleaner than smuggling `active` into `NewCampaignInput`).
- No schema change for scheduling (fields exist) or channel status (read live from Shopify per gift; not
  stored — avoids a staleness cache to reconcile).

## Scope + reinstall

- **`embedded=true`** (toml) — redeploy, not a scope reinstall, but App Bridge + session-token
  verification are new.
- **`read_product_listings`** — only if confirmed necessary for the "unlisted" sub-state (open question).
  Any scope change updates `GIFT_ENGINE_SCOPES` + `shopify.app.toml` + the Dashboard and **forces
  re-consent/reinstall** on the store. Prefer `read_products` + `publishedOnPublication` to avoid it.

---

## Staged rollout (smallest useful admin slice → full)

- **Stage A — embedded shell + read-only list.** Add Polaris + App Bridge + `embedded=true` +
  session-token-verified embedded API; render a **read-only campaign list** (`listByShop`). _Dev-test:_
  open the app in the dev admin, see seeded campaigns. Lowest risk; establishes the auth boundary.
- **Stage B — campaign + tier editor (draft only). SHIPPED.** Create/edit via the repo: name, schedule
  (UTC), decline, suppression fixed highest-only (read-only), tiers (ONE base-currency threshold per
  tier — no currency dropdown, no per-market rows; the FX track is separate — OR/AND, gift variant
  picker via App Bridge `resourcePicker({type:'variant'})` with labels resolved server-side via
  `POST /api/admin/variant-labels`). Saves as **inactive draft**
  (no provisioning/activation). Writes verify the App Bridge JWT (`authenticateShop`); ownership-checked
  (→404); refuses to edit an active campaign (→400). Tier-shape validation is pure + tested:
  `packages/core/configValidation.validateCampaignConfig` (ascending thresholds, AND≥2, OR≥1, no dup
  variant/option-id, one currency) + `apps/admin/src/admin/campaignValidation.validateCampaignInput`
  (suppression policy, schedule order, name, dup-market). Admin decimal entry ↔ Money minor units via
  `editorMapping.ts` (the `packages/shopify` currency-exponent boundary — JPY-safe). Files:
  `app/{AdminApp,CampaignEditor,appBridge}.tsx`, `app/api/admin/campaigns/[id]/route.ts` (+ POST on the
  collection route), `src/admin/{editorTypes,editorMapping,campaignValidation,routeHelpers}.ts`.
  No data-model/migration change (the schema already models Campaign/Tier/MarketThreshold). _Dev-test:_
  build a campaign in the UI; verify rows in the DB; `/config` still inactive (not activated).
- **Stage C — activate/deactivate + provisioning automation.** `setActive`; on activate run
  `provisionGifts` + eager-mint + (on edit) supersede; on deactivate run teardown + deactivate codes.
  _Dev-test:_ activate in the UI → collection/tags provisioned → widget offers gifts; deactivate → gifts
  gone, codes deactivated.
- **Stage D — qualifying-scope setting (model-C Stage 4).** `qualifyingScope` field + editor control
  (anything vs tag) + the gift-must-carry-the-tag surfacing; wire to `ensureQualifyingCollection` rule.
  _Dev-test:_ set a tag condition → collection rule = `TAG EQUALS`, gifts carry the tag, only matching
  products qualify; clear it → "anything".
- **Stage E — channel/availability policy.** Add the publication/listing check to `resolveCampaignConfig`
  - `/validate` candidate filtering (customer-side) and the editor's dim + explicit-remove (admin-side).
    Resolve the scope decision here. _Dev-test:_ unpublish a gift → widget stops offering it (and removes a
    live one) → admin shows it dimmed with a remove action → re-publish → it can re-apply.
- (**Stage F, later:** drop `write_products` if the inclusion model no longer tags — coordinate with the
  scope decision; reinstall.)

---

## Biggest risks

1. **Embedded session-token auth is a new security boundary** — the embedded API must verify the App
   Bridge JWT on every call, or admin mutations are open. Get this right in Stage A before any mutation.
2. **Provisioning-on-activate is side-effectful + partly async** (tag/flip collection, membership settle,
   mint). It can hard-fail; the activate flow must be transaction-like: don't leave a campaign "active"
   that mints against a broken/empty scope. Surface failures in the UI.
3. **Shared collection vs per-campaign tag scopes.** Today there's ONE shared `fge-qualifying` collection.
   "anything" keeps that simple. A per-campaign **tag-condition** scope may need its own collection/rule —
   the single-shared-collection invariant breaks with multiple distinct scopes across active campaigns.
   For the GreenTee single-store/"anything" case this is fine; flag before building multi-scope.
4. **Scope reinstall** if `read_product_listings` proves necessary (re-consent on the store).
5. **Supersede correctness on edit** — editing an active campaign's scope/threshold/gift-set must
   deactivate stale codes and re-mint; the repo `update` won't do it, so the activate/save orchestration
   must.

## Open questions (resolve / verify on dev before building)

1. **Channel signal + scope:** does `Product.publishedOnPublication(<online-store publication>)`
   (`read_products`, no new scope) distinguish **on-channel** vs **unlisted**, or is
   `read_product_listings` (ProductListing) actually required for "unlisted"? This decides whether a
   reinstall is needed. (Contradicts the user's stated `read_product_listings`; the
   `gift-availability-three-dimensions` finding says `read_products` suffices for publication.)
2. **Provision timing under a future-dated schedule:** is provisioning-now acceptable for a campaign that
   starts later (it tags/flips the shared collection now), or must provisioning defer to `startsAt`
   (→ needs a cron, dropping the lazy model)?
3. **Mint eagerly at activate vs lazily on first `/validate`?** (Recommend eager to surface failures.)
4. **Per-campaign tag-condition scope:** one shared collection or per-scope collections? (Risk #3.)
5. **Multiple active campaigns:** `makeResolveActiveCampaign` currently picks the first `c.active` — does
   the admin allow only one active campaign at a time, or must resolution pick among several? (Affects the
   list UI + activation rules.)
