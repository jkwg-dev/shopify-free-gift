# Phase 4 smoke test — /validate end-to-end on a dev store

Mocked unit tests cannot prove the real platform behaviors the architecture rests on (Shopify
applying a 100%-off scoped code at the **native** checkout, the minimum-subtotal backstop, and
non-combinability enforcing suppression). This runbook validates them on a dev store.

> **Do not run any of this until the dev-store target and dev database branch are confirmed.**
> It creates a real campaign + real discount codes on a real store.

## What we're proving

1. A qualifying cart yields a code that drops the gift to **$0 in the native checkout**.
2. An **AND** tier frees **all** its gift variants under **one** code.
3. An **OR** tier frees **exactly the chosen** variant.
4. Dropping below threshold makes the gift **revert to paid** (the discount's base-currency minimum is the backstop).
5. A lower-tier code **cannot be stacked** on the top-tier code (non-combinability ⇒ suppression holds).
6. In a **non-base market**, the **presentment** threshold and the **100%-off** gift both hold.
7. **/validate latency** on the checkout-click path is acceptable (the one thing CLAUDE.md says to measure).

## Prerequisites

- A Shopify **dev store** (Advanced-equivalent; no Plus features) with:
  - At least 4 distinct gift product variants and 1+ normal priced product.
  - A non-base **market** enabled (e.g. Canada/CAD) with the gift + normal products priced there.
- The dev **Postgres** branch (Neon / Vercel Postgres). `DATABASE_URL` + `DIRECT_URL` set.
- App env set (Vercel project env or `.env`): `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_SECRET` (App Proxy secret), `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_API_VERSION=2026-04`, `SHOPIFY_BASE_CURRENCY=USD`.
- **App Proxy** configured (Partner Dashboard / `shopify.app.toml`): prefix `apps`, subpath `free-gift`, URL → the deployment. Storefront path becomes `POST /apps/free-gift/validate`.

## Setup

```sh
# 1. Apply migrations to the dev branch (committed migrations; never db push).
pnpm --filter @free-gift-engine/admin exec prisma migrate deploy

# 2. Seed ONE highest-only campaign (AND tier + OR tier + CAD market threshold).
#    Fill the gift variant GIDs from real dev-store product variants.
SEED_AND_VARIANT_1=gid://shopify/ProductVariant/AAA \
SEED_AND_VARIANT_2=gid://shopify/ProductVariant/BBB \
SEED_OR_VARIANT_A=gid://shopify/ProductVariant/CCC \
SEED_OR_VARIANT_B=gid://shopify/ProductVariant/DDD \
SHOPIFY_SHOP_DOMAIN=our-dev-store.myshopify.com \
pnpm --filter @free-gift-engine/admin run seed:smoke

# 3. Deploy the /validate route (Vercel), or run `vercel dev`, and confirm the App Proxy
#    forwards https://{shop}/apps/free-gift/validate to it.
```

Seeded campaign: tier 1 **AND** unlocks at **$50** (gifts AAA + BBB), tier 2 **OR** unlocks at
**$100** (choose CCC or DDD). Suppression is **highest-only**, so $50–$99 frees tier 1; ≥ $100
frees tier 2 and suppresses tier 1.

> The storefront UI (auto-add, perception widget, OR chooser, decline) is **Phase 5**. Until then,
> drive /validate directly (the theme's job) to fetch the code, then apply it via
> `https://{shop}/discount/{CODE}` and proceed to checkout — that is exactly what Phase 5 will
> automate. A signed App Proxy request is required; easiest is to trigger it from a storefront
> fetch on the dev theme, or replay a captured signed request.

## Steps — record expected vs actual

| #   | Scenario             | Action                                                                                                            | Expected                                                                                           | Actual |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| 1a  | Tier 1 band          | Cart = normal items totaling **$60** (USD market) → call /validate                                                | `gift`, `tierId` = tier 1, `code` returned, `appliedThreshold` = $50                               |        |
| 1b  | Apply + checkout     | Apply `/discount/{code}`, open native checkout                                                                    | Tier-1 gift line(s) show **$0**; subtotal/áother items unchanged                                   |        |
| 2   | AND frees both       | In step 1, both AAA **and** BBB present as gifts                                                                  | **Both** AAA and BBB are $0 under the **one** code                                                 |        |
| 3a  | Tier 2 OR (choose A) | Cart = **$120**, choices `{ "<tier2Id>": "a" }`                                                                   | `gift`, tierId = tier 2, `giftVariantIds` = `[CCC]` only                                           |        |
| 3b  | OR exact variant     | Apply code, checkout                                                                                              | **CCC** is $0; **DDD** is not discounted                                                           |        |
| 3c  | Suppression          | In step 3, confirm tier-1 gifts (AAA/BBB)                                                                         | Tier-1 gifts are **not** free (highest-only suppresses lower)                                      |        |
| 4   | Drop below threshold | From a qualifying cart with the code applied, remove items to **< $50**                                           | At checkout the gift **reverts to paid** (minimum not met)                                         |        |
| 5   | Non-combinable       | Obtain the tier-1 code (≤$99 cart) and the tier-2 code (≥$100 cart); apply the **lower** on top of the **higher** | Shopify **blocks** stacking — only one product-class code applies; no double gift                  |        |
| 6a  | Non-base market      | Switch to **CAD** (country CA); cart ≥ **CA$70**                                                                  | `gift`, `currency` = CAD, `appliedThreshold` = **CA$70** (resolved, not $50 USD)                   |        |
| 6b  | Non-base $0          | Apply code, checkout in CAD                                                                                       | Gift is **$0** (100%-off is currency-agnostic); threshold shown = threshold enforced               |        |
| 7   | Latency              | Measure /validate round-trip: first (cold) call and a warm call                                                   | Record both. If checkout-path latency is a real problem, _then_ consider the CF Worker (CLAUDE.md) |        |

### Latency measurement

Record p50/p95 if possible; at minimum one cold + one warm:

| Call       | Round-trip (ms) |
| ---------- | --------------- |
| cold start |                 |
| warm       |                 |

## Negative checks (optional but recommended)

- Unsigned / tampered App Proxy request → **401**.
- `declined: true` → `no-gift` / `declined`; no code minted.
- Out-of-stock a gift variant → `no-gift` / `gift-unavailable`.
- Hammer the endpoint past the limit (60/min) → **429**.
- Two simultaneous qualifying calls → **one** discount in the Shopify admin, same code.

## After the smoke test

- If all steps pass: proceed to **Phase 3b** (Polaris admin UI) against the frozen contracts.
- If latency (step 7) is a real problem: open the Cloudflare Worker question per CLAUDE.md — not before.
- Record results (fill the Actual column) and attach to the Phase 4 review.
