# free-gift-engine

Internal Shopify app: a configurable free-gift promotion engine for our single store. Replaces Kite for the free-gift use case. Built so new promotions are configured in the admin UI, not coded by hand.

## Hard constraints (non-negotiable)

- Shopify plan: ADVANCED, not Plus.
- NO Shopify Functions anywhere. (Custom-distribution apps with Functions require Plus.) Pricing and enforcement use the Admin API + native discounts only.
- NO draft orders. The native checkout must stay intact: discount field, Shop Pay, abandoned-cart recovery, analytics, inventory reservation.
- A free gift = 100% off the specific gift variant(s), issued as a discount scoped to those variants with a minimum-purchase condition, via the Admin API. 100% off is currency-agnostic and works for all markets.
- Server is authoritative. Recompute subtotal and eligible tier server-side. Never trust client totals or tier claims.
- Lower-tier suppression is enforced by discount scoping: only the highest qualified tier's gift is in scope (free). A lower gift in the cart is out of scope, so charged at full price. No revenue leak.
- Storefront = Theme App Extension (OS 2.0 app block) on a Liquid theme with an AJAX cart drawer. No checkout.liquid, no theme-code surgery.
- Multi-currency / multi-market store.

## Architecture

- apps/admin: Next.js embedded admin (App Bridge + Polaris). Campaign CRUD. Persists to Postgres via Prisma.
- packages/core: pure functions for tier resolution, gift selection (OR/AND), suppression, decline handling, and schedule-window checks. No I/O. Fully unit-tested. The only place business rules live.
- packages/shopify: typed Admin API wrappers (products, discounts, OAuth, webhooks).
- /validate: hosted as a Next.js route by default (move to a Cloudflare Worker only if checkout-time latency requires it). Cart in -> recompute tier via packages/core -> create/reuse scoped discount -> return { discountCode, gifts } -> storefront applies and continues to the native checkout.
- extensions/theme: app block + storefront JS. Reads active campaign config, renders the perception UX, reconciles gift lines on cart change, calls /validate at checkout.
- scheduler: cron (Vercel Cron or CF Cron Triggers) flips campaign active state at startsAt/endsAt.

### apps/admin is split: 3a backend (built) + 3b UI (deferred)

- **Phase 3a (done)** is the headless data layer + route-handler logic, with React/Polaris deferred to 3b. The pure logic (mapping store, supersede, services) depends only on repository/gateway **ports**; Prisma and the Shopify package are outer adapters injected at the composition root (dependency inversion). Postgres is a hosted dev branch (Neon/Supabase/Vercel; no Docker); migrations are committed (`prisma migrate`, never `db push`), with `DIRECT_URL` for migrations.
- **Frozen contract**: `apps/admin/src/contract.ts` holds the JSON request/response shapes the 3b Polaris UI consumes. 3b builds against these and must not reopen 3a.
- **`configVersionHash` is identity-independent**: keyed on (threshold, gift-set) + suppression only, never a DB/tier id — so a new campaign and an edit that recreates tier rows hash the same when the scope is unchanged (no needless code churn).
- **Security**: offline access tokens are stored with authenticated encryption at rest (AES-256-GCM; key from a secret manager / `TOKEN_ENCRYPTION_KEY`), never plaintext. OAuth-callback and webhook HMACs are verified (constant-time) before processing; App Bridge session tokens (HS256 JWT) are verified on every embedded API request.
- **Compliance webhooks**: the mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are required only for **App-Store / public-distribution** apps (confirmed against Shopify docs). This is a **custom-distribution** app for a single internal store and holds **no shopper PII** (only shop tokens, campaign config, opaque codes), so they are not required — but we verify HMAC and acknowledge them defensively so the app stays compliant if distribution ever changes.

## Pricing & enforcement flow

1. Storefront detects a qualifying subtotal, adds the correct gift line(s) per the active campaign, and shows the perception UX.
2. At checkout click, the storefront posts the cart to /validate.
3. /validate recomputes subtotal and tier server-side, picks the exact highest-tier gift(s), creates a discount scoped to those variants + min-spend, returns the code.
4. Storefront applies the code (e.g. /discount/CODE) and proceeds to native checkout.
5. If the shopper drops below threshold, the min-spend condition stops the discount (gift reverts to paid). A re-added lower gift is out of scope, so never free.

### `isGift` is server-authoritative (NEVER client-trusted)

`packages/core` excludes gift lines from the qualifying subtotal via a per-line `isGift` flag — correct for a pure function, but whoever populates that flag is the security boundary. **`/validate` MUST derive `isGift` server-side and MUST NOT forward the client's claim.**

- The attack: if a real, app-added free-gift line keeps its full sticker price in the subtotal (because its `isGift` tag was stripped or never set), that price can push the cart into a higher tier the shopper did not pay for — and then that tier's gift is discounted to $0. Free money leak.
- The server rule: a line is a non-qualifying gift line **iff** its variant is in the active campaign's resolved gift-variant set **AND** it was app-added (identified by the app's gift line-item property / marker). Both conditions, server-checked.
- Paid-duplicate edge case: a shopper may also buy a gift-eligible product as a normal paid item. That paid unit MUST still count toward the subtotal; only the app-added free unit is excluded. So exclusion is per-line (the marked free unit), not per-variant — never zero out every line whose variant happens to be gift-eligible.

### Currency minor units (decimal exponent is currency-specific)

Core `Money` is integer minor units, but the minor-unit exponent depends on the currency: 2 for most, **0 for zero-decimal currencies (JPY, KRW)**, 3 for BHD/KWD. `packages/shopify` is the parse/format boundary: when it reads Shopify `MoneyV2` (decimal string + `currencyCode`) or parses an admin-configured threshold, it MUST apply the currency's exponent. A JPY/KRW threshold parsed with a hardcoded ×100 is off by 100×. Make the exponent explicit at parse/format; test a zero-decimal currency.

### Decision: tier thresholds across markets

- A campaign tier stores a single **base-currency threshold** plus a **manual per-market FX table** (admin-entered rate or explicit converted amount per market). No live FX feed: rates are fixed at configure time so the enforced number is predictable and auditable.
- The campaign schema is **per-market-aware**: a tier resolves to a concrete threshold for the shopper's resolved market before any tier comparison. Market resolution + FX conversion happen upstream (in `/validate` / the storefront context), never inside `packages/core`. Core receives subtotal and threshold already in one resolved currency.
- **Invariant**: the threshold the widget shows the shopper ("Spend $X more") MUST equal the threshold actually enforced for that market — i.e. the same converted figure feeds both the perception UX and the discount's minimum-purchase condition. The displayed number and the enforced number are one value, never computed twice by two paths.

### Decision: discount code minting

- A discount code is **reusable**, keyed by the tuple `(campaignId, tierId, resolvedGiftSetHash, configVersionHash)`. The same qualifying state always maps to the same code.
- **One code per resolved OR choice**: each distinct resolved gift-set (the shopper's A-or-B pick, fully resolved) gets its own code. `resolvedGiftSetHash` is computed over the resolved variant set so OR branches never collide.
- **Idempotent lookup in Postgres**: before minting, look up the key tuple; reuse the stored code if present, otherwise create it once and persist. Concurrent `/validate` calls for the same state converge on one code (unique constraint on the key tuple).
- **Base-currency minimum**: the discount's minimum-purchase condition is set in the store's base currency so a single code serves all markets; Shopify applies the native market conversion at checkout. We do not mint a code per market.
- `configVersionHash` covers the campaign config that affects pricing/scope (tiers, thresholds, gift-sets, suppression mode). On a config change the hash changes, so a **new** code is minted and **stale codes are deactivated**; we **never mutate a live code's scope or minimum** in place. Live codes are immutable; supersede, don't edit.
- The hash inputs — the resolved tier and resolved gift-set — are produced by the pure functions in `packages/core` (unit-testable here). The actual Shopify code creation + Postgres persistence stays in `packages/shopify` / the `/validate` route.
- **Gift codes are non-combinable among themselves (this is what makes reusable codes safe for suppression)**. Every gift code is created with `combinesWith.productDiscounts: false`. Our gift codes are product-class code discounts, so Shopify allows only one product-class discount per cart — a shopper who discovers a lower-tier code cannot manually stack it on top of the highest-tier code. Suppression is therefore enforced at the **discount layer**, not only by `/validate` handing out a single code. (Confirmed against 2026-04: combinability is governed solely by `combinesWith`; `productDiscounts` defaults to `false`, and same-line product-discount stacking requires Plus + `productDiscounts: true`, which we are on Advanced and never set.) If a campaign ever needs a gift to stack with a _separate_ promo (e.g. an order-level percentage code), it may set `orderDiscounts`/`shippingDiscounts` true but MUST keep `productDiscounts: false`, or suppression breaks. The admin UI MUST NOT expose any toggle that can set `productDiscounts: true` for gift codes.

## Storefront UX: perception (required)

The shopper MUST clearly notice the gift. No silent additions.

- Tier/progress widget: "Spend $X more to unlock [gift]" and a clear "Unlocked: [gift]" state. Render in the cart drawer and on the cart page.
- On auto-add: a visible toast/inline message ("Free gift added: [name]") and ensure the cart drawer updates immediately (refresh or open as the theme allows).
- Gift line styling in cart: a "Free gift" / "$0" badge, the original price shown as a strikethrough, and a gift icon. The line must read as an intentional reward, not a mystery item.
- OR tiers: an explicit chooser ("Choose your free gift: A or B"). Persist the choice as a line-item property so it survives a refresh.
- Decline: a clearly labeled "Add my free gift" checkbox, checked by default, that removes or re-adds the gift line.
- Robustness: subscribe to the theme's cart-change events, debounce, avoid flicker and double-adds, and handle the drawer re-rendering. Must work on mobile and meet basic accessibility (labels, focus, contrast).

## Tooling & conventions

- Monorepo via pnpm workspaces + Turborepo.
- TypeScript strict everywhere. No `any` without an inline justification.
- ESLint (typescript-eslint) + Prettier, one shared config at the root.
- Husky + lint-staged: pre-commit runs format + lint + typecheck on staged files.
- commitlint with Conventional Commits.
- Vitest. packages/core stays near-100% covered.
- GitHub Actions CI: typecheck + lint + test on every PR.
- Pin the Shopify API version; revisit each quarter for deprecations.
- Secrets in .env (gitignored). Never commit tokens.

## Code quality & design

Apply clean-code and SOLID ideas as concrete rules, not as a license to over-abstract.

Structure (this is how SRP and dependency inversion apply to this repo):

- Business rules live only in packages/core, as pure functions. No I/O, no Shopify or DB calls there.
- All Admin API access goes through packages/shopify wrappers. Nothing else calls the Shopify API or fetch directly.
- UI (apps/admin, extensions/theme) holds no business logic. It calls core and shopify.
- Dependencies point inward: admin/theme -> shopify -> core. core depends on nothing. No cycles.

Functions and modules:

- One responsibility per function/module. If a function needs a comment to explain a second job, split it.
- Keep functions small. Over ~40 lines or more than 4 params is a smell; refactor or justify inline.
- Name by intent (resolveTier, scopeDiscountToGifts), not by type or layer.
- Make illegal states unrepresentable with types. Prefer discriminated unions over boolean flags. No `any` without an inline reason.
- Errors are explicit: return typed results or throw typed errors. Never swallow.

Guardrails against over-engineering (priority, given the app's size):

- YAGNI. Build the simplest design that passes the tests for the current requirement.
- No interface or abstraction with a single implementation. No factory, strategy, or layer added "for the future".
- No new dependency for something a few lines can do. Ask first.
- Duplication is cheaper than the wrong abstraction. Extract only on the third real repeat.

## Working agreement (for Claude Code)

- This file is the source of truth. If a decision changes, update this file in the same change.
- Plan before large changes. Keep each commit/PR to one concern. Use Conventional Commits.
- Definition of done, per change: types pass, lint passes, tests pass; new core logic has unit tests for the edge cases (OR, AND, suppression, decline, schedule); no dead code, no commented-out blocks, no unfiled TODOs.
- Run typecheck + lint + tests before calling anything done.
- Never introduce Shopify Functions or draft orders.
- Ask before adding non-trivial dependencies.
- Use /clear between unrelated tasks to keep context tight.
