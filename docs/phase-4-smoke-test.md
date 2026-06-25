# Phase 4 smoke test — /validate end-to-end on a dev store

Mocked unit tests cannot prove the real platform behaviors the architecture rests on (Shopify
applying a 100%-off scoped code at the **native** checkout, the minimum-subtotal backstop, and
non-combinability enforcing suppression). This runbook validates them on a dev store.

> **Do not run any of this until the dev-store target and dev database branch are confirmed.**
> It installs the app, creates a real campaign, and mints real discount codes on a real store.

## Status

**Phase 4: PASSED** — acceptance = the direct signed `/validate` call returns our correct `gift`
JSON end-to-end (App Proxy signature verify → server-authoritative resolution → scoped-code
minting).

Four pre-production gate items (recorded; finally **observed live in Phase 5b** with the real cart,
or in the published-storefront follow-up):

| Gate item                                      | Where it's finally observed                                  | Status                                     |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| Drop-below-threshold revert (gift → paid)      | 5b live cart + native checkout                               | pending live (logic unit-tested)           |
| Non-combinability (lower code can't stack)     | 5b live cart + native checkout                               | pending live (enforced by `combinesWith`)  |
| CAD presentment threshold (resolved, not base) | signed call shows `appliedThreshold`; confirm at 5b checkout | verified via signed call; checkout pending |
| Real Shopify → App Proxy forwarding            | published Online Store channel (follow-up)                   | **UNVERIFIED** until publish               |

> 5b's live cart widget is where **drop-below revert** and **non-combinability** are first
> observed against a real cart/checkout; until then they rest on the unit tests + the discount's
> `combinesWith` + minimum-subtotal backstop.

## What we're proving

1. Each tier's gift drops to **$0 in the native checkout** via the applied code.
2. The **AND** tier frees **both** variants under **one** code.
3. The **OR** tier frees **exactly the chosen variant** — including a choice between **sibling variants of one product**.
4. **highest-only suppression**: only the highest qualifying tier's gift is free; lower tiers are not.
5. Dropping below threshold makes the gift **revert to paid** (the discount's base-currency minimum is the backstop).
6. A lower-tier code **cannot be stacked** on the top-tier code (non-combinability ⇒ suppression holds).
7. A **paid duplicate** of a gift-eligible product still counts toward the subtotal (per-line exclusion).
8. An **out-of-stock** chosen variant returns `gift-unavailable` (never promise an unfulfillable gift).
9. In a **non-base market** (USD here; base is CAD), the **presentment** threshold and the **100%-off** gift both hold.
10. **/validate latency** on the checkout-click path is acceptable (the one thing CLAUDE.md says to measure).

## Seeded campaign (real spec; highest-only)

This dev store's **base currency is CAD**; the non-base market exercised is **USD**.

| Tier | Unlock (base CAD / market USD) | Kind                 | Options           |
| ---- | ------------------------------ | -------------------- | ----------------- |
| 1    | CA$500 / US$370                | OR (choose one)      | `a`, `b`          |
| 2    | CA$1000 / US$740               | AND (both, one code) | (two variants)    |
| 3    | CA$1500 / US$1110              | OR (choose one of 8) | `opt-1` … `opt-8` |

Bands (highest-only): **CA$500–999** → tier 1 · **CA$1000–1499** → tier 2 (tier 1 suppressed) ·
**CA$1500+** → tier 3 (tiers 1–2 suppressed).

## Stand-in fixtures (Option B — product identity irrelevant; counts match 2 / 2 / 8)

The seed stores variant GIDs only (no product names; the engine keys on variant GID). Real GIDs on
greentee-dev (verified live; CAD prices via `contextualPricing(CA)`):

| Role / option id | Product · variant                 | Variant GID                                   | CAD price · stock         |
| ---------------- | --------------------------------- | --------------------------------------------- | ------------------------- |
| tier 1 `a`       | The Complete Snowboard · **Ice**  | `gid://shopify/ProductVariant/44289298038893` | 699.95 · in stock         |
| tier 1 `b`       | The Complete Snowboard · **Dawn** | `gid://shopify/ProductVariant/44289298071661` | 699.95 · in stock         |
| tier 2 (AND) #1  | The **Hidden** Snowboard          | `gid://shopify/ProductVariant/44289298301037` | 749.95 · in stock         |
| tier 2 (AND) #2  | The **Multi-location** Snowboard  | `gid://shopify/ProductVariant/44289298595949` | 729.95 · in stock         |
| tier 3 `opt-1`   | The Collection Liquid · **S**     | `gid://shopify/ProductVariant/45375032393837` | 749.95 · in stock         |
| tier 3 `opt-2`   | The Collection Liquid · **M**     | `gid://shopify/ProductVariant/45375032426605` | 749.95 · in stock         |
| tier 3 `opt-3`   | The Collection Liquid · **L**     | `gid://shopify/ProductVariant/45375032459373` | 749.95 · **OUT OF STOCK** |
| tier 3 `opt-4`   | The Collection Snowboard: Oxygen  | `gid://shopify/ProductVariant/44289298727021` | 1025.00 · in stock        |
| tier 3 `opt-5`   | The Minimal Snowboard             | `gid://shopify/ProductVariant/44289297711213` | 885.95 · in stock         |
| tier 3 `opt-6`   | The Videographer Snowboard        | `gid://shopify/ProductVariant/44289298333805` | 885.95 · in stock         |
| tier 3 `opt-7`   | The Compare at Price Snowboard    | `gid://shopify/ProductVariant/44289297842285` | 785.95 · in stock         |
| tier 3 `opt-8`   | The Multi-managed Snowboard       | `gid://shopify/ProductVariant/44289298628717` | 629.95 · in stock         |

> **Stock correction (live data):** only **Liquid L (`opt-3`) is out of stock**; **S and M are in
> stock**. So the gift-unavailable step uses **`opt-3` (L)**, not M. If you want M out of stock too,
> set it in the dev store; otherwise use L.

`opt-1..opt-3` are three sibling variants of one product (The Collection Liquid) → a variant-granular
case; the chooser must offer S/M/L as distinct options, never collapse them.

**Qualifying paid item** (crosses CA$500, not a gift variant): **The Collection Snowboard: Hydrogen**
— `gid://shopify/ProductVariant/44289298235501`, **CA$600.00** via `contextualPricing(CA)`, in stock.

## Values you must supply (do not commit; from env / secret manager)

These are environment-specific and cannot be invented — provide them in Vercel env / `.env`:

| Value                         | Purpose                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `SHOPIFY_SHOP_DOMAIN`         | the dev store, e.g. `our-dev-store.myshopify.com`                                                   |
| `SHOPIFY_API_KEY`             | **Client ID** from the Dev Dashboard app                                                            |
| `SHOPIFY_API_SECRET`          | **Client secret** — the SINGLE shared secret for OAuth HMAC, webhook HMAC, AND App Proxy signature  |
| `SHOPIFY_APP_URL`             | the app/host URL (Vercel production), e.g. `https://your-app.vercel.app`                            |
| `SHOPIFY_SCOPES`              | `read_products,write_products,write_discounts,read_discounts` (must match the toml + Dashboard app) |
| `SHOPIFY_API_VERSION`         | `2026-04`                                                                                           |
| `SHOPIFY_BASE_CURRENCY`       | `CAD` (this store's base)                                                                           |
| `TOKEN_ENCRYPTION_KEY`        | AES-256-GCM key, base64 (`openssl rand -base64 32`) — encrypts the offline token at rest            |
| `DATABASE_URL` / `DIRECT_URL` | the Neon dev branch (pooled / direct)                                                               |
| `SEED_*` GIDs                 | real `ProductVariant` GIDs (2 + 2 + 8 = 12), below                                                  |

> No admin access token here — it's obtained by **OAuth install** and stored encrypted in the Shop
> row; the app decrypts it per request.

The exact env var names the seed reads (role-based; the $1500 tier is ONE comma-separated list):

```
SEED_OR500_A=gid://shopify/ProductVariant/44289298038893     # Complete Snowboard - Ice
SEED_OR500_B=gid://shopify/ProductVariant/44289298071661     # Complete Snowboard - Dawn
SEED_AND1000_A=gid://shopify/ProductVariant/44289298301037   # Hidden
SEED_AND1000_B=gid://shopify/ProductVariant/44289298595949   # Multi-location
# Eight options, ONE comma-separated list (opt-1..opt-8): Liquid S, M, L(OOS), Oxygen, Minimal,
# Videographer, Compare-at-Price, Multi-managed
SEED_OR1500_GIDS=gid://shopify/ProductVariant/45375032393837,gid://shopify/ProductVariant/45375032426605,gid://shopify/ProductVariant/45375032459373,gid://shopify/ProductVariant/44289298727021,gid://shopify/ProductVariant/44289297711213,gid://shopify/ProductVariant/44289298333805,gid://shopify/ProductVariant/44289297842285,gid://shopify/ProductVariant/44289298628717
```

## Prerequisites

- A Shopify **dev store** (Advanced-equivalent; no Plus features), base currency **CAD**, with the
  stand-in variants above, 1+ normal priced product, and a non-base **USD** market enabled and
  priced. Per live data, **Liquid L is out of stock** (S and M in stock) — used for the
  gift-unavailable step.
- Make at least one gift variant (e.g. Complete Snowboard · Ice) **also** normally purchasable so
  step 7 (paid-duplicate) can be exercised.
- App Proxy: prefix `apps`, subpath `free-gift` (see the repo-root `shopify.app.toml`) ⇒ storefront
  path **`POST /apps/free-gift/validate`**.

## Setup (current flow — Dev Dashboard OAuth install)

Since 2026-01-01 legacy custom apps can't be created from the Shopify admin; create the app in the
**Dev Dashboard** and install it via an install link.

1. **Create the app** in the Dev Dashboard as an installable **OAuth** app. Note its **Client ID**
   and **Client secret**.
2. **Link + configure** config-as-code (run from `apps/admin`, interactively in your own terminal):
   ```sh
   cd apps/admin && shopify app config link    # writes client_id into shopify.app.toml
   ```
   Then fill the `https://…vercel.app` placeholders in `shopify.app.toml` (application_url, the
   `[auth] redirect_urls` callback, `[app_proxy]` url, webhook URLs) and confirm `[access_scopes]`
   = `read_products,write_products,write_discounts,read_discounts`. (If the CLI rejects/rewrites
   anything, set it in the Dev Dashboard UI instead — see the note in the toml.) `write_products` is
   required to tag gift products + create the qualifying collection (BXGY); see `docs/phase-5b-reseed.md`.
3. **Provision the Neon dev branch**; set `DATABASE_URL` + `DIRECT_URL`, then apply migrations
   (committed; never db push):
   ```sh
   pnpm --filter @free-gift-engine/admin exec prisma migrate deploy
   ```
4. **Deploy to Vercel** with all env vars from the table above (Node runtime; region near the DB).
   `shopify app deploy` pushes the app config. Set distribution = **Custom**, target **greentee-dev**,
   and generate the **install link**.
5. **Install**: open the install link, approve. The OAuth callback exchanges the code, encrypts the
   offline token, and writes it to the Neon **Shop** row; the App Proxy goes live.
6. **Gate check — unsigned request is rejected**:
   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     https://your-app.vercel.app/apps/free-gift/validate -d '{}'      # expect 401
   ```
7. **Seed** the campaign (real greentee-dev GIDs from the env block above) — prints the tier ids:
   ```sh
   DATABASE_URL=... DIRECT_URL=... \
   SHOPIFY_SHOP_DOMAIN=greentee-dev.myshopify.com \
   SEED_OR500_A=gid://shopify/ProductVariant/44289298038893 \
   SEED_OR500_B=gid://shopify/ProductVariant/44289298071661 \
   SEED_AND1000_A=gid://shopify/ProductVariant/44289298301037 \
   SEED_AND1000_B=gid://shopify/ProductVariant/44289298595949 \
   SEED_OR1500_GIDS=gid://shopify/ProductVariant/45375032393837,gid://shopify/ProductVariant/45375032426605,gid://shopify/ProductVariant/45375032459373,gid://shopify/ProductVariant/44289298727021,gid://shopify/ProductVariant/44289297711213,gid://shopify/ProductVariant/44289298333805,gid://shopify/ProductVariant/44289297842285,gid://shopify/ProductVariant/44289298628717 \
   pnpm --filter @free-gift-engine/admin run seed:smoke
   ```

### Calling /validate during the walk (signed request)

The code is only minted when `/validate` is hit. Shopify signs app-proxy requests on the way to
your app (the client never signs), so the helper reproduces that forwarded request and sends it
**directly to the app origin** (`APP_URL`), then prints the status + body:

```sh
SHOPIFY_API_SECRET=<client secret> APP_URL=https://your-app.vercel.app \
SHOP=greentee-dev.myshopify.com \
BODY='{"cart":[{"variantId":"gid://shopify/ProductVariant/123","quantity":1,"appAdded":false}],"choices":{"<tier1Id>":"a"},"declined":false,"presentmentCurrency":"CAD","countryCode":"CA"}' \
pnpm --filter @free-gift-engine/admin run sign-proxy
```

Expect `HTTP 200` with our JSON (`{"status":"gift",...}` / `{"status":"no-gift",...}`). Then apply
the returned code via `https://{shop}/discount/{CODE}` and proceed to the native checkout.

> **Password-protected dev store caveat:** this helper targets the **app origin**, not
> `https://{shop}/apps/free-gift/validate`. Don't self-sign and POST to the storefront URL — Shopify
> appends its own `signature` (two `signature` params → 401), and a client signature can't pass the
> password page. To exercise the _real_ Shopify→proxy path you must **publish the Online Store
> channel** (then the request is unsigned by you — Shopify signs it). The direct signed call proves
> the app end-to-end (signature verify → resolution → minting); Shopify's edge forwarding is the
> only part it doesn't cover.

> The storefront UI (auto-add, perception widget, OR chooser, decline) is **Phase 5**. Until then,
> drive `/validate` directly (the theme's future job): POST the cart to the App-Proxy path, then
> apply the returned code via `https://{shop}/discount/{CODE}` and proceed to checkout. A valid
> signed App Proxy request is required (trigger from a storefront fetch on the dev theme, or replay
> a captured signed request).

## Steps — record expected vs actual

| #   | Scenario              | Action                                                                                            | Expected                                                                                | Actual |
| --- | --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| 1   | Tier 1 variant choice | **1× Hydrogen (CA$600)**, choose `a` (Ice) → /validate → apply → checkout; repeat with `b` (Dawn) | Each yields `gift`, tier 1, exactly the chosen variant at **$0** under **its own code** |        |
| 2   | Tier 2 (AND) both     | **2× Hydrogen (CA$1200)** → /validate → apply → checkout                                          | `gift`, tier 2; **both** variants are **$0** under the **one** code                     |        |
| 3   | Tier 3 (OR ×8) exact  | **3× Hydrogen (CA$1800)**, choose an in-stock option (e.g. `opt-4` Oxygen) → apply → checkout     | `gift`, tier 3, only that variant is $0; other options unaffected                       |        |
| 4   | Suppression           | At CA$1200 inspect tier-1 gift; at CA$1600 inspect tier-1/2 gifts                                 | Lower-tier gifts are **not** free (only the highest qualifying tier)                    |        |
| 5   | Drop below threshold  | From a qualifying cart with the code applied, remove items below the tier threshold               | At checkout the gift **reverts to paid** (minimum not met)                              |        |
| 6   | Non-combinable        | Get the tier-1 code (~CA$600) and tier-3 code (~CA$1600); apply the lower on top of the top       | Shopify **blocks** stacking — one product-class code applies; no double gift            |        |
| 7   | Paid duplicate        | Cart with an **app-added free** Ice line **and** a separately **paid** Ice line                   | The paid unit **counts** toward the subtotal; only the free unit is excluded            |        |
| 8   | Gift-unavailable      | At CA$1800, choose `opt-3` (Collection Liquid **L**, out of stock)                                | `no-gift` / `gift-unavailable`; choosing `opt-1` (S, in stock) instead succeeds         |        |
| 9   | Non-base market (USD) | Switch to **USD** (country US); cart ≥ **US$370**, choose a tier-1 gift → apply → checkout        | `currency=USD`, `appliedThreshold=US$370` (resolved, not CA$500); gift is **$0**        |        |
| 10  | Latency               | Measure /validate round-trip: first (cold) and a warm call                                        | Record both; if checkout-path latency is a real problem, _then_ weigh the CF Worker     |        |

### Latency measurement

| Call       | Round-trip (ms) |
| ---------- | --------------- |
| cold start |                 |
| warm       |                 |

## Negative checks (optional but recommended)

- Unsigned / tampered App Proxy request → **401**.
- `declined: true` → `no-gift` / `declined`; no code minted.
- Hammer the endpoint past the limit (60/min) → **429**.
- Two simultaneous qualifying calls → **one** discount in the Shopify admin, same code.

## Phase 4 acceptance vs. required follow-up (two different proofs)

These prove different things; neither replaces the other:

- **Phase 4 acceptance — direct signed call to the app origin.** Proves OUR code end-to-end:
  App-Proxy signature verify → server-authoritative resolution → scoped-code minting. This is the
  acceptance gate for Phase 4.
- **Required follow-up (NOT a Phase 4 blocker) — real storefront → App Proxy path.** The
  edge-forwarding leg stays **UNVERIFIED** until this runs: Shopify actually forwarding
  `https://greentee-dev.myshopify.com/apps/free-gift/validate` to the app with a Shopify-generated
  signature. Failures invisible to the direct call live here — a wrong App Proxy **subpath**, a
  non-base **proxy URL**, or an **unpublished** channel. The direct call cannot catch any of these.

  Steps: **publish the Online Store channel** on greentee-dev (its storefront/password gate
  currently blocks proxy requests), then hit the storefront proxy URL **without** signing (Shopify
  signs on forward) and confirm you get our `gift`/`no-gift` JSON, not a `/password` redirect or 404.
  Record the result; until then the edge leg is unproven.

## After the smoke test

- Phase 4 acceptance = the direct signed call returns our `gift` JSON end-to-end. Then proceed to
  **Phase 3b** (Polaris admin UI) against the frozen contracts.
- Queue the **published-storefront proxy test** above as the required follow-up.
- If latency (step 10) is a real problem: open the Cloudflare Worker question per CLAUDE.md — not before.
- Record results (fill the Actual column) and attach to the Phase 4 review.
