# Multi-currency FX hardening — design

**Status: IMPLEMENTED (2026-06-27) with the three decisions locked to the recommendations below
(ignore stored rows; non-base + no rate → inactive; rate as string). Adversarially verified by a
multi-agent review (math / no-leak / additivity / regressions) — no code defects; the three confirmed
findings were all test-coverage gaps, now closed (JPY end-to-end, derived-threshold boundary,
base-currency rate-ignore). Theme deploy required for the widget rate capture.**

**Original design below. No schema change. Closes Gap A (new campaigns inactive
in non-base markets) and Gap B (manual-FX-table vs Shopify-rate drift) in one move, by DERIVING the
presentment threshold from Shopify's own market rate — the same rate Shopify uses to convert the CAD
BXGY minimum at checkout.**

Builds on the diagnosis: the only hard money gate is the **CAD BXGY minimum** (`discounts.ts:107`),
which **Shopify converts** to presentment at checkout. Today `presentmentThreshold()`
(`service.ts:90`) reads a stored manual `marketThresholds[].resolvedThreshold` for non-base markets;
the editor no longer writes those rows, and the manual rate drifts from Shopify's. We replace that
lookup with a derivation.

## Confirmed rate source (dev finding)

- The **Admin API does not expose** Shopify's automatic presentment rate (Market/MarketCurrencySettings
  have no rate; `shop.currencySettings[].manualRate` is null for every auto currency). So the **server
  cannot read the live rate**.
- The live rate **is on the storefront**: `window.Shopify.currency = { active: "USD", rate: "0.71866446" }`,
  verified to be exactly the rate Shopify applies (CA$570 × 0.71866446 = US$409.64 = the
  `contextualPricing` presentment price, and the same rate Shopify uses to convert the CAD minimum at
  checkout).

⇒ The rate must travel **client → server**. The widget reads `window.Shopify.currency.rate` at request
time and passes it to `/validate` and `/config`; the server computes
`presentmentThreshold = ceil(baseThreshold × rate)` in the presentment currency.

## Core idea (one rate, everywhere)

After this change, all three figures from the diagnosis collapse onto **Shopify's market rate**:

| Figure                                 | Source after change                        | Rate                                          |
| -------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Cart subtotal                          | `contextualPricing` (unchanged)            | Shopify market price                          |
| Tier threshold (display + `/validate`) | `baseThreshold(CAD) × clientRate`, **NEW** | Shopify rate (`window.Shopify.currency.rate`) |
| BXGY minimum (checkout gate)           | CAD, Shopify-converted (unchanged)         | Shopify rate                                  |

Because `window.Shopify.currency.rate` _is_ Shopify's market rate, the threshold and the enforced
minimum now use the **same** rate ⇒ **display == `/validate` == BXGY floor** by construction. We do NOT
change cart pricing (still `contextualPricing`) — only the threshold derivation.

---

## 1. Rate plumbing (the crux)

### Where the rate is read

The widget reads `window.Shopify.currency.rate` (string) and `.active` **at request-build time**, not
from the Liquid dataset — a shopper can switch currency via a storefront selector, which updates
`window.Shopify.currency` live. The dataset's `presentmentCurrency`/`country` stay as today; the rate is
the only dynamic addition.

### `/validate` (POST) — rate rides in the body

The App Proxy HMAC signs **query params only** (`handler.ts:133`); the body (`cart`, `choices`,
`presentmentCurrency`, …) is already an unsigned, re-validated **claim**. The rate joins that set:

- `core/validate.ts` `ValidateRequest`: add `readonly presentmentRate?: string` (additive; OPTIONAL so
  an old widget build still parses — see fallback in §4).
- `handler.ts parseRequest`: parse `presentmentRate` → require a **finite, > 0** number when present;
  reject otherwise (400, `INVALID_REQUEST`).

### `/config` (GET) — rate rides in the query

`/config` params go through the App Proxy signature (signed-as-forwarded), like `currency`/`country`:

- `core/campaignConfig.ts` `CampaignConfigRequest`: add `readonly presentmentRate?: string`.
- `configClient.ts`: add `rate` to the `URLSearchParams`.
- `configHandler.ts`: read `single(req.query['rate'])`, same > 0 validation.

Both are **additive** to the frozen wire contracts (optional field), mirroring how the currency-exponent
boundary was added without reopening callers.

### Trust analysis (client-supplied rate)

The rate is client-chosen (body for `/validate`; signed-as-forwarded for `/config` — Shopify proves it
forwarded the value, not that the value is correct). **A spoofed rate can only break the UX promise,
never leak revenue or overcharge**, because:

- The **cart subtotal** is computed server-side from `contextualPricing` (`service.ts:131`) — the rate
  is **not** used to price the cart.
- The **BXGY minimum** is CAD, converted by **Shopify** at checkout (`discounts.ts:107`) — the rate is
  **not** used there.
- The client rate is used **only** to derive the displayed/`/validate` threshold. So:
  - rate too **low** → threshold too low → `/validate` over-offers → BXGY refuses at checkout → gift
    reverts to paid (**broken promise**, no leak).
  - rate too **high** → threshold too high → gift hidden (**under-offer**, harmless).
- It cannot change which variant is the gift, the minted code, or the CAD minimum (the minting key and
  `minimumSubtotal` are server/Shopify). A reused code is idempotent (one per tuple), so a spoofed rate
  can't proliferate codes.
- The presentment **currency** is still validated against `contextualPricing` (`service.ts:135`), so a
  spoofed currency is rejected independently of the rate.

**No place a bad rate does worse than a self-inflicted UX glitch.** (Server-validatable alternative
checked: neither `/cart.js` nor a cheaply-reachable Storefront API field gives a server-verifiable
`presentment_currency_rate`; client-passed rate it is.)

---

## 2. Conversion + rounding rule

New **pure** helper at the currency-exponent boundary (`packages/shopify/src/money.ts`, which already
owns `currencyExponent`), unit-tested:

```
convertBaseToPresentmentCeil(base: Money, presentmentCurrency: string, rate: number): Money
  eB = currencyExponent(base.currency)         // CAD -> 2
  eP = currencyExponent(presentmentCurrency)   // USD -> 2, JPY -> 0
  presentMinor = ceil( base.amountMinor * rate * 10^(eP - eB) )
  -> money(presentMinor, presentmentCurrency)
```

- **`rate` multiplies MAJOR base → MAJOR presentment** (as Shopify defines it: 570 × 0.7187 = 409.64);
  the `10^(eP−eB)` factor re-expresses the result in presentment **minor** units and handles
  zero-decimal currencies.
- **Round UP (`ceil`) to the presentment minor unit.** This guarantees the derived threshold is **≥**
  Shopify's converted minimum, so `/validate` is at worst **≤ 1 minor unit stricter** than BXGY — we
  **only ever under-offer at the boundary, never over-offer** (no broken promise from rounding/timing
  skew). Worked examples:
  - USD: `ceil(50000 × 0.71866446) = ceil(35933.22) = 35934` → **$359.34** (Shopify min-convert ≈
    $359.33 → we're 1¢ stricter, safe).
  - JPY: `ceil(50000 × rate × 10^(0−2))` → whole yen.

---

## 3. Exact change points

| Layer                        | File                                                              | Change                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FX math                      | `packages/shopify/src/money.ts` (+ test)                          | NEW `convertBaseToPresentmentCeil` (pure). Export from index.                                                                                                                                                                                                                                             |
| Threshold                    | `apps/admin/src/validate/service.ts` `presentmentThreshold` (~90) | New `rate` param. `presentment === base` → `tier.baseThreshold` (rate ignored). Else → `convertBaseToPresentmentCeil(tier.baseThreshold, presentment, rate)`. **Stored `marketThresholds` rows are ignored** (see §5). Returns null only when no rate is available in a non-base market (→ inactive, §4). |
| `/validate` service          | `service.ts` `resolveValidate` (~119)                             | Thread `request.presentmentRate` into `presentmentThreshold`. Everything else (cart pricing, core resolve, BXGY mint) unchanged.                                                                                                                                                                          |
| `/config` service            | `apps/admin/src/validate/configService.ts` (~68)                  | Same: pass `request.presentmentRate` into the shared `presentmentThreshold`. Widget == `/validate` by construction.                                                                                                                                                                                       |
| `/validate` contract + parse | `core/validate.ts`, `handler.ts`                                  | Add optional `presentmentRate` (body); validate > 0.                                                                                                                                                                                                                                                      |
| `/config` contract + parse   | `core/campaignConfig.ts`, `configHandler.ts`, `configClient.ts`   | Add optional `presentmentRate` / `rate` query param; validate > 0.                                                                                                                                                                                                                                        |
| Widget (theme deploy)        | `packages/theme-widget/src/storefront.ts` (+ `validateClient.ts`) | Read `window.Shopify.currency.rate` at request time; include it in the `/validate` body and the `/config` query. Extend the `ThemeWindow.Shopify` type with `currency?: { active: string; rate: string }`. Rebuild `extensions/theme/assets/free-gift.js`.                                                |
| BXGY minimum                 | `packages/shopify/src/discounts.ts:107`                           | **UNCHANGED** — minimum stays base CAD; Shopify converts per market. No per-market minimum, ever.                                                                                                                                                                                                         |

The stepper auto-max (`progressGraph.ts`, `highest × 4/3`) keeps working: it reads the per-tier
`threshold` from `/config`, which now carries the derived presentment figure — no stepper change.

---

## 4. Edge cases

- **Base currency (`presentment === base`, CAD):** return `tier.baseThreshold` directly; skip the
  multiply/ceil. (`window.Shopify.currency.rate` is `1.0` in the base market, but we don't rely on it.)
- **Zero-decimal presentment (JPY/KRW):** handled by `10^(eP−eB)` in the helper; ceil to whole units.
- **Market whose local base differs (UK=GBP):** irrelevant to our logic — we always compute
  shop-base **CAD × rate** vs the buyer's presentment. In a GBP market `window.Shopify.currency.rate`
  is the CAD→GBP rate; the CAD BXGY minimum is Shopify-converted to GBP identically.
- **`window.Shopify.currency` absent / rate missing or invalid:** recommended behavior —
  - base-currency market → fine (no rate needed);
  - **non-base market + no valid rate → campaign INACTIVE in that market** (`presentmentThreshold`
    returns null → `no-gift: inactive`). Safest: never offer a gift we can't price against the
    enforced floor. (This is no worse than today's Gap A.)
  - Optional extra safety net during transition: if a legacy stored row exists, fall back to it instead
    of going inactive — see §5; **not recommended** long-term (reintroduces drift).

---

## 5. Migration & legacy rows

- **No schema migration.** We _stop requiring_ `MarketThreshold` rows; the table/columns stay (frozen
  schema + `contract.ts` unchanged). `prisma migrate` not needed.
- **Legacy rows on the live campaign:** the live campaign still has manual USD/GBP `resolvedThreshold`
  rows (rate ~0.74). **Recommendation: the derive-path IGNORES them** and always computes CAD × rate.
  Consequence: the live USD threshold shifts from the manual **$370** to the derived **≈$359** (CA$500 ×
  Shopify's 0.7187, ceiled) — which is _more_ correct (it matches what checkout actually enforces) and
  kills the drift. **No re-mint needed:** the BXGY minimum is CAD and unchanged, so existing codes stay
  valid; only the displayed/`/validate` threshold changes. The dead rows age out naturally (editing the
  live campaign already writes `marketThresholds: []`).
- Re-provisioning is unaffected (it touches the qualifying collection + codes, not thresholds).

---

## 6. Dev verification plan

Switch `?country=` and read `window.Shopify.currency.rate` in the console to predict expected numbers.

1. **New campaign, non-base market (closes Gap A).** Create + activate a NEW campaign (no market rows).
   `?country=US`: the gift now shows in USD with thresholds = `CA$500/1000/1500 × rate` (ceiled, e.g.
   ~$359.34 / $718.67 / $1,078.00 at 0.71866446). Confirm `/config` and `/validate` agree (same figure).
2. **Display == enforced (closes Gap B).** Note the displayed tier-1 threshold; build the USD cart to
   just above it; proceed to checkout and confirm the BXGY gift is honored ($0). Then just **below** the
   displayed threshold → no gift offered, and if forced, not honored. The ceil band (≤1¢) should show
   `/validate` as _slightly stricter_ than BXGY (under-offer), never the reverse.
3. **GBP market.** `?country=GB`: thresholds = `CAD × GBP rate`; gift shows and is honored at checkout.
4. **Base currency unchanged.** `?country=CA`: thresholds exactly CA$500/1000/1500 (rate = 1).
5. **Boundary sweep.** Walk the USD cart across a tier threshold (e.g. ±$2 around tier 2): confirm the
   stepper "Spend $X more", the tier swap, the code applied, and the checkout grant all agree.
6. **Missing-rate fallback.** Temporarily null `window.Shopify.currency` (console) and reload in a
   non-base market → confirm graceful **no gift** (not a wrong CAD-numbers offer); base market still works.
7. **(If a JPY market is enabled)** `?country=JP`: thresholds in whole yen, ceiled; checkout honors.

---

## Open decisions for approval

1. **Ignore vs prefer legacy stored `marketThresholds` rows** in the derive-path. Recommended:
   **ignore** (single source of truth = Shopify rate; live threshold becomes more accurate; no re-mint).
2. **Missing-rate fallback** in a non-base market. Recommended: **inactive** (no gift), not a
   legacy-row fallback.
3. **`presentmentRate` as string vs number** on the wire. Recommended: **string** (preserve Shopify's
   8-dp precision as given), parsed to a `number` server-side.

No code until these are approved.
