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

## Pricing & enforcement flow

1. Storefront detects a qualifying subtotal, adds the correct gift line(s) per the active campaign, and shows the perception UX.
2. At checkout click, the storefront posts the cart to /validate.
3. /validate recomputes subtotal and tier server-side, picks the exact highest-tier gift(s), creates a discount scoped to those variants + min-spend, returns the code.
4. Storefront applies the code (e.g. /discount/CODE) and proceeds to native checkout.
5. If the shopper drops below threshold, the min-spend condition stops the discount (gift reverts to paid). A re-added lower gift is out of scope, so never free.

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
