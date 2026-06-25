# Phase 4 smoke test — /validate end-to-end on a dev store

Mocked unit tests cannot prove the real platform behaviors the architecture rests on (Shopify
applying a 100%-off scoped code at the **native** checkout, the minimum-subtotal backstop, and
non-combinability enforcing suppression). This runbook validates them on a dev store.

> **Do not run any of this until the dev-store target and dev database branch are confirmed.**
> It installs the app, creates a real campaign, and mints real discount codes on a real store.

## What we're proving

1. Each tier's gift drops to **$0 in the native checkout** via the applied code.
2. The **AND** tier frees **both** variants under **one** code.
3. The **8-option OR** tier frees **exactly the chosen** hat.
4. **highest-only suppression**: only the highest qualifying tier's gift is free; lower tiers are not.
5. Dropping below threshold makes the gift **revert to paid** (the discount's base-currency minimum is the backstop).
6. A lower-tier code **cannot be stacked** on the top-tier code (non-combinability ⇒ suppression holds).
7. A **paid duplicate** of a gift-eligible product still counts toward the subtotal (per-line exclusion).
8. In a **non-base market** (CAD), the **presentment** threshold and the **100%-off** gift both hold.
9. **/validate latency** on the checkout-click path is acceptable (the one thing CLAUDE.md says to measure).

## Seeded campaign (real spec; highest-only)

| Tier | Unlock (USD / CAD) | Kind                     | Gifts                                  |
| ---- | ------------------ | ------------------------ | -------------------------------------- |
| 1    | $500 / CA$700      | OR (choose one)          | GFJ Socks · GFJ Arm Sleeves            |
| 2    | $1000 / CA$1400    | AND (both, one code)     | GFJ Club Brush · GFJ G-Bear Tee Holder |
| 3    | $1500 / CA$2100    | OR (choose one of **8**) | GFJ Hat × 8                            |

Bands (highest-only): **$500–999** → tier 1 · **$1000–1499** → tier 2 (tier 1 suppressed) ·
**$1500+** → tier 3 (tiers 1–2 suppressed).

## Values you must supply (do not commit; from env / secret manager)

These are environment-specific and cannot be invented — provide them in Vercel env / `.env`:

| Value                         | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `SHOPIFY_SHOP_DOMAIN`         | the dev store, e.g. `our-dev-store.myshopify.com`           |
| `SHOPIFY_ADMIN_ACCESS_TOKEN`  | offline Admin API token (created when the app is installed) |
| `SHOPIFY_API_SECRET`          | app shared secret — used to verify the App Proxy signature  |
| `SHOPIFY_API_VERSION`         | `2026-04`                                                   |
| `SHOPIFY_BASE_CURRENCY`       | `USD`                                                       |
| `TOKEN_ENCRYPTION_KEY`        | AES-256-GCM key (only if storing the token encrypted)       |
| `DATABASE_URL` / `DIRECT_URL` | the dev Postgres branch (pooled / unpooled)                 |
| 12 × `SEED_*` GIDs            | real `ProductVariant` GIDs (below)                          |

Gift variant GIDs (2 + 2 + 8 = **12**):

```
SEED_OR500_SOCKS=gid://shopify/ProductVariant/...
SEED_OR500_SLEEVES=gid://shopify/ProductVariant/...
SEED_AND1000_BRUSH=gid://shopify/ProductVariant/...
SEED_AND1000_TEEHOLDER=gid://shopify/ProductVariant/...
SEED_HAT_1=gid://shopify/ProductVariant/...
SEED_HAT_2=gid://shopify/ProductVariant/...
SEED_HAT_3=gid://shopify/ProductVariant/...
SEED_HAT_4=gid://shopify/ProductVariant/...
SEED_HAT_5=gid://shopify/ProductVariant/...
SEED_HAT_6=gid://shopify/ProductVariant/...
SEED_HAT_7=gid://shopify/ProductVariant/...
SEED_HAT_8=gid://shopify/ProductVariant/...
```

> Make at least one gift variant (e.g. `SEED_OR500_SOCKS`) **also** normally purchasable so step 7
> (paid-duplicate) can be exercised.

## Prerequisites

- A Shopify **dev store** (Advanced-equivalent; no Plus features) with the 12 gift variants above,
  1+ normal priced product, and a non-base **market** enabled (Canada/CAD) with those products
  priced there.
- App Proxy: prefix `apps`, subpath `free-gift` (see `apps/admin/shopify.app.toml`) ⇒ storefront
  path **`POST /apps/free-gift/validate`**.

## Setup

```sh
# 1. Provision the dev Postgres branch (Neon / Vercel Postgres) and set DATABASE_URL + DIRECT_URL.

# 2. Apply committed migrations to that branch (never db push).
pnpm --filter @free-gift-engine/admin exec prisma migrate deploy

# 3. Register + install the app on the dev store so the App Proxy exists and an offline
#    access token is issued (set SHOPIFY_ADMIN_ACCESS_TOKEN / SHOPIFY_API_SECRET from it).

# 4. Deploy the /validate route to Vercel (or `vercel dev`); confirm the App Proxy forwards
#    https://{shop}/apps/free-gift/validate to it.

# 5. Seed the campaign with the 12 real GIDs (see env block above).
SHOPIFY_SHOP_DOMAIN=... \
SEED_OR500_SOCKS=... SEED_OR500_SLEEVES=... \
SEED_AND1000_BRUSH=... SEED_AND1000_TEEHOLDER=... \
SEED_HAT_1=... SEED_HAT_2=... SEED_HAT_3=... SEED_HAT_4=... \
SEED_HAT_5=... SEED_HAT_6=... SEED_HAT_7=... SEED_HAT_8=... \
pnpm --filter @free-gift-engine/admin run seed:smoke
```

> The storefront UI (auto-add, perception widget, OR chooser, decline) is **Phase 5**. Until then,
> drive `/validate` directly (the theme's future job): POST the cart to the App-Proxy path, then
> apply the returned code via `https://{shop}/discount/{CODE}` and proceed to checkout. A valid
> signed App Proxy request is required (trigger from a storefront fetch on the dev theme, or replay
> a captured signed request).

## Steps — record expected vs actual

| #   | Scenario             | Action                                                                                     | Expected                                                                              | Actual |
| --- | -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------ |
| 1   | Tier 1 (OR) → $0     | USD cart ≈ **$600**, choices `{ "<tier1Id>": "socks" }` → /validate → apply → checkout     | `gift`, tier 1, `giftVariantIds=[socks]`; socks shows **$0** at native checkout       |        |
| 2   | Tier 2 (AND) both    | USD cart ≈ **$1200** → /validate → apply → checkout                                        | `gift`, tier 2; **both** brush + tee-holder are **$0** under the **one** code         |        |
| 3   | Tier 3 (OR ×8) exact | USD cart ≈ **$1600**, choose `hat-5` → /validate → apply → checkout                        | `gift`, tier 3, `giftVariantIds=[hat 5]`; **only hat 5** is $0; other hats unaffected |        |
| 4   | Suppression          | In step 2 ($1200), inspect tier-1 gifts; in step 3 ($1600), inspect tier-1/2 gifts         | Lower-tier gifts are **not** free (only the highest qualifying tier)                  |        |
| 5   | Drop below threshold | From a qualifying cart with the code applied, remove items below the tier threshold        | At checkout the gift **reverts to paid** (minimum not met)                            |        |
| 6   | Non-combinable       | Get the tier-1 code (~$600 cart) and tier-3 code (~$1600 cart); apply the lower on the top | Shopify **blocks** stacking — one product-class code applies; no double gift          |        |
| 7   | Paid duplicate       | Cart with an **app-added free** socks line **and** a separately **paid** socks line        | The paid unit **counts** toward the subtotal; only the free unit is excluded          |        |
| 8   | Non-base market      | Switch to **CAD** (country CA); cart ≥ **CA$700**, choose a tier-1 gift → apply → checkout | `currency=CAD`, `appliedThreshold=CA$700` (resolved, not $500 USD); gift is **$0**    |        |
| 9   | Latency              | Measure /validate round-trip: first (cold) and a warm call                                 | Record both; if checkout-path latency is a real problem, _then_ weigh the CF Worker   |        |

### Latency measurement

| Call       | Round-trip (ms) |
| ---------- | --------------- |
| cold start |                 |
| warm       |                 |

## Negative checks (optional but recommended)

- Unsigned / tampered App Proxy request → **401**.
- `declined: true` → `no-gift` / `declined`; no code minted.
- Out-of-stock a chosen hat → `no-gift` / `gift-unavailable` (and Phase 5 will hide that option).
- Hammer the endpoint past the limit (60/min) → **429**.
- Two simultaneous qualifying calls → **one** discount in the Shopify admin, same code.

## After the smoke test

- If all steps pass: proceed to **Phase 3b** (Polaris admin UI) against the frozen contracts.
- If latency (step 9) is a real problem: open the Cloudflare Worker question per CLAUDE.md — not before.
- Record results (fill the Actual column) and attach to the Phase 4 review.
