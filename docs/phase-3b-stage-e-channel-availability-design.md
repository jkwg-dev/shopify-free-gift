# Phase 3b — Stage E: channel / availability policy (Q5)

**Status:** APPROVED — building E1. All four decisions locked (§Locked decisions below).
**Scope:** make an unpublished-to-Online-Store **or** out-of-stock gift behave consistently across the
two surfaces: **greyed-out in the admin editor**, **not offered on the storefront**. Read-only — we do
**not** auto-publish (`read_products` only; no `write_publications`, no `read_product_listings`, no
reinstall — the whole point of Q5).

## Locked decisions

1. **AND tier with an unavailable required gift → ALL-OR-NOTHING.** Any required gift unavailable → the
   tier grants no gift; widget shows the bundle greyed with a note. Matches one-BXGY-code-per-gift-set;
   `/validate` already loops all winning gifts and returns `gift-unavailable` if any fails (§4) — formalize
   that. No per-variant code splitting.
2. **Activate with an unavailable in-scope gift → SOFT WARNING, no block** (E3). List unavailable gifts,
   stronger note if a whole tier is dead (zero offerable), confirm-and-proceed. Stock/publish are transient
   and the storefront filters live, so a hard block would wrongly prevent activation.
3. **Storefront unavailable option → DISABLE + GREY** ("Currently unavailable"), not hidden. Keeps the
   shopper informed and matches the admin greying (same predicate, both surfaces).
4. **Publication id → ENV VAR `SHOPIFY_ONLINE_STORE_PUBLICATION_ID`, validated, FAIL-FAST.** See §5a.

## 5a. Missing/malformed publication id — fail-fast, never silent (the C2-class trap)

The C2 `FGE_GIFTS_INCLUDED` miss was a SILENT wrong-path (app worked superficially with the wrong
behavior). Stage E must not repeat it. Rejected behaviors:

- **Silent fallback to stock-only** — exactly the C2 trap (invisible wrong path). REJECTED.
- **Fail-closed to "not offerable"** — silently hides EVERY gift; reads as a catalog bug, not a config
  bug. REJECTED.

**Chosen: fail-fast with a NAMED error scoped to the availability path — not whole-app-fail-at-boot.**

- A single accessor `requireOnlineStorePublicationId()` reads `SHOPIFY_ONLINE_STORE_PUBLICATION_ID`,
  validates the format (`gid://shopify/Publication/<digits>`), and throws a named
  `MissingPublicationConfigError` on missing/empty/malformed. It is the ONLY source of the publication id,
  so there is **no code path that computes availability without it** → it can never degrade to stock-only.
- Called **eagerly** when the availability deps are constructed (earliest point of each request, before
  serving anything) — the serverless equivalent of "validated at boot": immediate + named, not buried
  mid-computation.
- **Scoped, not whole-app:** only `/config`, `/validate`, and (E2) the admin availability endpoint touch
  it, so a misconfig 500s those (loud, logged, widget visibly stops) but does NOT take down OAuth /
  webhooks / draft CRUD — a smaller blast radius that also doesn't hamper fixing it. Still impossible to
  miss, unlike C2's silent success.

**PRODUCTION CHECKLIST (do not miss like FGE_GIFTS_INCLUDED):** dev's id is
`gid://shopify/Publication/157545496685`. **Production's Online Store publication id is DIFFERENT** — look
it up in prod (`publications(first:10){ nodes { id name } }` → pick "Online Store") and set
`SHOPIFY_ONLINE_STORE_PUBLICATION_ID` separately in **production Vercel env**. E1's boot validation makes a
missing/malformed value fail loudly rather than silently skip the publication check.

Verified on dev (the crux):

- Online Store publication id = `gid://shopify/Publication/157545496685`.
- `product.publishedOnPublication(publicationId: <OnlineStore>)` returns true/false under **our existing
  `read_products`** scope. **Use this.**
- `product.publishedOnCurrentPublication` **requires `read_product_listings`** (access-denied on dev). **Do
  not use it.**
- `variant.availableForSale`, `variant.inventoryQuantity`, `product.totalInventory` all read on
  `read_products`.

---

## 1. Where the 8/10 filtering happens today

The storefront chooser shows 8 of 10 because **`/config` already computes a per-option `available` flag
from stock only**, and the widget disables/greys options where it is false. No new filtering is needed —
it already exists; Stage E just **adds the publication dimension** to it and **surfaces the same predicate
in the admin**.

Concretely:

- **`apps/admin/src/validate/configService.ts:82-114`** (server, App Proxy `GET /apps/free-gift/config`)
  fetches `priceVariants(giftVariantIds, { country })` + `fetchVariantMeta(giftVariantIds)`, then sets per
  gift item/option:
  ```
  available = (pricing.availableForSale ?? false) && metaResolved   // configService.ts:86,98
  ```
  So today's predicate = **priced-in-market AND in-stock AND resolves-to-a-product**. **Publication is NOT
  in it.**
- **`packages/theme-widget/src/chooser.ts:72-93`** reads that `available` flag AND a runtime
  `unavailableVariantIds` set; effective availability = `configAvailable && !runtimeUnavailable`. Unavailable
  options are **disabled + greyed ("Currently unavailable")**, not hidden. An AND tier is marked
  `incomplete` if any item is unavailable (`chooser.ts:88`).
- **`runtimeUnavailable`** (`storefront.ts:112,202`) is populated _reactively_ — when a `/cart/add.js` 422s,
  the widget marks that variant unavailable after the fact.

**Why exactly 8/10:** the 2 dropped options are `availableForSale: false` (the known OOS Liquid M/L
variants). `availableForSale` is **per-variant stock/sellability** — so two sibling variants of one product
can diverge, which matches "5 candidate products all ACTIVE+published+in-stock, but 2 _variants_ missing."

**The gap Stage E closes:** `availableForSale` reflects stock, **not channel publication** (see memory
`gift-availability-three-dimensions`). An **unpublished but in-stock** gift reads `availableForSale: true`,
so `/config` marks it `available: true`, the chooser offers it, and `/cart/add.js` **422s** — only then is
it greyed reactively. Stage E makes publication a **proactive** input to the predicate so it is never
offered, and shows the merchant the reason in the admin.

---

## 2. The shared availability predicate (single source of truth)

One pure function, unit-tested in `packages/core`, consumed by **both** surfaces (both are server-side: the
`/config` builder for the storefront, and the admin endpoint for greying — the widget only renders the
resulting boolean).

```ts
// packages/core/src/giftAvailability.ts  (pure, ~100% covered)
export type GiftUnavailableReason =
  | 'unresolved' // variant deleted / no longer a ProductVariant
  | 'unpriced' // no contextual price in this market (market context only)
  | 'not-published' // product not on the Online Store publication
  | 'out-of-stock'; // variant.availableForSale === false

export type GiftAvailability =
  | { readonly offerable: true; readonly reason: null }
  | { readonly offerable: false; readonly reason: GiftUnavailableReason };

export function giftOfferability(signals: {
  readonly resolved: boolean; // meta resolved
  readonly priced?: boolean; // present only when a market context is given
  readonly publishedToOnlineStore: boolean;
  readonly inStock: boolean; // = availableForSale
}): GiftAvailability;
```

- **`offerable` = `resolved && (priced ?? true) && publishedToOnlineStore && inStock`.**
- **Reason precedence** (report the most fundamental failure first):
  `unresolved → unpriced → not-published → out-of-stock`.
- `priced` is **optional**: the storefront passes it (market-specific via `contextualPricing`); the **admin
  omits it** (greying is market-agnostic — publish + stock are not per-market). So the same predicate serves
  both; only the inputs differ.
- The widget keeps consuming a plain `available: boolean` (= `offerable`). The admin additionally consumes
  `reason` for its label. The predicate is the **only** place "is this gift offerable" is decided.

### Reading publication + stock (new `packages/shopify` wrapper)

```ts
// packages/shopify/src/channelAvailability.ts
export type GiftChannelAvailability = {
  readonly availableForSale: boolean;
  readonly publishedToOnlineStore: boolean;
};
export async function fetchGiftChannelAvailability(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
  publicationId: string, // the Online Store publication GID
): Promise<Map<string, GiftChannelAvailability>>;
```

GraphQL (read_products only, batched 250 like the existing wrappers):

```graphql
query GiftChannelAvailability($ids: [ID!]!, $pub: ID!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      availableForSale
      product {
        publishedOnPublication(publicationId: $pub)
      }
    }
  }
}
```

Publication is a **product-level** concept, stock a **per-variant** one — so the predicate is per variant:
`product.publishedOnPublication ∧ variant.availableForSale`. Unresolved ids are simply absent from the map
(treated as `unresolved`), mirroring `fetchVariantPricing`/`fetchVariantMeta`.

**Publication id source:** new env `SHOPIFY_ONLINE_STORE_PUBLICATION_ID`
(`gid://shopify/Publication/157545496685` on dev), read in `composition.ts` and injected as a dep — added to
`.env.example`. (Discoverable via `publications(first:10)` if it ever changes; env keeps it explicit and
auditable, consistent with the rest of the config.)

`fetchVariantPricing` is **unchanged** — it still serves cart-line subtotal pricing, which needs no
publication. We add the new wrapper rather than bloat the hot cart-pricing query.

---

## 3. ADMIN surface — gift availability greying (the Q5 headline)

**Goal:** in the editor's selected-gift list, a gift that is published + in stock renders normally; one that
is **not published to Online Store OR out of stock** renders **greyed with a reason badge** ("Not published
to Online Store" / "Out of stock"). Read-only signal — no publish action, no write.

**Endpoint:** extend the existing `POST /api/admin/variant-labels` path (it already resolves gift metadata
under the App Bridge session-token boundary). `resolveVariantLabels(shop, ids)` becomes
`resolveGiftDisplay(shop, ids)` returning, per variant, `{ variantId, label, availability }` where
`availability = giftOfferability({ resolved, publishedToOnlineStore, inStock })` (no `priced` — market-agnostic).
Internally it fans out `fetchVariantMeta` + `fetchGiftChannelAvailability` in parallel and combines via the
shared predicate.

**Why fold into variant-labels (not the campaign GET view):** the editor already calls this path on **pick**;
have it call the same path on **load** too, to hydrate labels + availability for already-selected gifts. This
keeps **volatile availability OUT of the frozen campaign contract** (`contract.ts` / `campaignToResponse`
stay about _persisted config_; availability is a live read, never persisted) and gives "reflected if
published mid-campaign" for free — every editor open re-resolves, no caching.

**UI** (`apps/admin/app/CampaignEditor.tsx:347-358`, the gift row): when `!offerable`, render the title with
`tone="subdued"` + a Polaris `Badge tone="warning"` carrying the reason text; keep the **Remove** button.
Nothing else changes; no publish button.

**Informational vs blocking on activate — RECOMMENDATION: informational + a soft warning, NOT a hard
block.**

- Greying is always informational.
- At **activate** (reuse C3's confirm-and-replace Modal pattern), if any in-scope gift is currently
  unavailable, show a **soft warning** listing them, and a **stronger** soft warning when a tier would have
  **zero** offerable gifts (an OR tier with all options unavailable, or an AND tier with any required gift
  unavailable — a "dead" tier that can never grant). The merchant can confirm-and-proceed.
- **No hard block** because stock/publish change at any time and the storefront filters live — a transient
  state should not prevent activation (e.g. activating ahead of a restock). A dead tier is surfaced loudly
  but still not force-blocked. (Open question #2 — confirm.)

---

## 4. STOREFRONT surface — unavailable gift treated as out-of-stock

**Location: `/config` (`configService.ts`), server-side — unchanged location, extended predicate.** Today
`available` = priced ∧ inStock ∧ resolved. Stage E swaps that one expression for the shared
`giftOfferability(...)` with the **publication** signal added (third parallel fetch:
`fetchGiftChannelAvailability(giftVariantIds, onlineStorePublicationId)`). Result: an unpublished gift now
gets `available: false` **proactively** — the chooser disables/greys it instead of offering it and eating a 422.

- **The widget needs no code change** — it already consumes `available` (`chooser.ts`). So Stage E's
  storefront change is **server-only (`apps/admin` on Vercel)**: no `shopify app deploy`, the widget bundle
  is untouched.
- **Presentation: keep DISABLED + greyed (shown, not selectable) — the current behavior** — rather than
  hiding the option. It is informative ("this hat is temporarily out of stock") and matches the admin
  greying so the two surfaces read identically. (Open question #3 — confirm vs hide.)
- **`/validate` backstop (`service.ts:230-237`) gets the same predicate** for defense-in-depth: for the
  winning tier's gift variants (1-2), also read publish + stock and return `gift-unavailable` if not
  offerable — not just on `!availableForSale`. One tiny batched read for the winning variants only (after
  resolve), off the cart-pricing path. This keeps `/config` and `/validate` on the **same** predicate.

**Minted code survives unavailability (confirmed):** availability gates **offering**, never minting. The code
key is `(campaignId, tierPosition, resolvedGiftSetHash, configVersionHash)` — availability is **not** in the
key. So an unavailable option keeps its already-minted code; when it becomes available again, `/config`
offers it and `/validate`'s `getOrCreate` finds the existing code and **reuses** it — **no re-mint**. Holds
cleanly with model-C and the supersede/teardown machinery (teardown is keyed by config version, not
availability).

### OR vs AND handling

- **OR:** drop (grey/disable) the unavailable option; the other options stand. Already how the chooser
  behaves; now correct for publication too. No tier-level effect.
- **AND (get ALL):** today `/validate`'s backstop **loops every winning gift** and returns
  `gift-unavailable` if **any** is unavailable (`service.ts:232-237`), and the chooser marks the tier
  `incomplete`. So the de-facto behavior is already **all-or-nothing**. **RECOMMENDATION: formalize
  all-or-nothing** — an AND tier is offerable iff **every** required gift is offerable; if any is
  unavailable the tier grants **no** gift and the widget shows the bundle greyed with an explicit
  "Temporarily unavailable" note. **Partial grant is impossible** with our one-code-per-gift-set model (one
  BXGY code grants the whole AND set together; splitting into per-variant codes contradicts "one code per
  resolved gift-set" and multiplies teardown). This is the real design question — **Open question #1.**

---

## 5. Scope confirmation — `read_products` only, no reinstall

- `product.publishedOnPublication(publicationId:)` → **`read_products`** (verified live). We do **not** use
  `publishedOnCurrentPublication` (needs `read_product_listings`).
- `availableForSale` → `read_products`.
- No `write_publications`, no `read_product_listings`, no scope change → **no reinstall**. The publication
  GID is config (env), not a scope. `GIFT_ENGINE_SCOPES` in `composition.ts` is unchanged.

Does **not** touch: model-C (`FGE_GIFTS_INCLUDED`), the activation track (C1–C3 + supersede), multi-currency
threshold derivation, or minting/teardown. The only new reads are publish+stock; the only new writes are
none.

---

## 6. Staged plan (smallest safe slice first)

- **E1 — shared predicate + publication read + storefront wiring.** Add core `giftOfferability` (unit
  tests: each reason, precedence, market-vs-no-market), shopify `fetchGiftChannelAvailability` + the
  publication-id env, wire the predicate into `configService` (publication now gates `available`) and the
  `/validate` backstop. **Outcome:** unpublished gifts are no longer offered (proactive, replacing the 422
  race); establishes the predicate E2/E3 reuse. **Server-only — Vercel deploy, no `shopify app deploy`.**
  _Dev-test:_ unpublish a published gift → chooser greys it with no 422; re-publish → offered again; set a
  gift variant OOS → greyed; restock → offered.
- **E2 — admin greying.** Extend `resolveVariantLabels` → `{ label, availability }`; editor calls it on
  load + pick; gift rows grey with a reason badge. Read-only, reflected-on-refresh. _Dev-test:_
  unpublish/OOS a selected gift → editor row greys with the right reason; publish/restock → normal on
  refresh.
- **E3 — activate soft-warning + AND-tier formalization.** Activate warns (soft, reusing the C3 Modal)
  listing unavailable gifts and dead tiers; formalize AND all-or-nothing with a clear widget note.
  _Dev-test:_ activate with an unavailable in-scope gift → warning (proceed allowed); AND tier with one
  required gift unavailable → no gift + note; OR tier fully unavailable → dead-tier warning at activate.

Order rationale: E1 is the smallest correctness win (and kills the 422 race) and builds the shared predicate;
E2 is pure read + UI; E3 is policy polish + the AND decision.

---

## 7. Biggest risks + open questions

**Risks**

1. **Publication-id correctness (the #1 risk).** A wrong/missing `SHOPIFY_ONLINE_STORE_PUBLICATION_ID` makes
   every gift read `not-published` → everything greyed / nothing offered. _Mitigation:_ validate at boot
   (query `publication(id:){ name }`, assert it's the Online Store) or log loudly; the E1 dev-test asserts a
   known-published gift reads `true`.
2. **`/validate` hot-path latency.** One extra batched read on checkout-click. _Mitigation:_ fetch publish+
   stock for the **winning** tier's gift variants only (1-2) after resolve; measure in the smoke test.
3. **`availableForSale` semantics.** It already encodes Shopify sellability (respects inventory policy), so a
   "continue selling when out of stock" variant reads `true` and _can_ be added — correct to offer.
   **Use `availableForSale`, NOT `inventoryQuantity <= 0`** (the latter would wrongly hide sellable
   continue-selling variants).
4. **Per-product publication vs per-variant stock.** Sibling variants share publish status but not stock;
   the predicate is per-variant (`productPublished ∧ variantInStock`). No issue, noted to avoid confusion.
5. **Consistency window.** Admin greying is a snapshot at load; storefront is per `/config` call — they can
   momentarily disagree if publish flips between. Acceptable; both re-read (reflected-on-refresh).

**Open questions (need your call)**

1. **AND-tier-unavailable** — confirm **all-or-nothing** (one unavailable required gift → tier grants no
   gift, widget shows a clear note). _Recommend yes_ (partial grant is impossible with one code).
2. **Activate behavior** — confirm **soft warning, no hard block**, including the dead-tier (zero offerable)
   case. _Recommend yes_ (you leaned this way; stock/publish are transient).
3. **Storefront presentation** — **disable + grey** the unavailable option (shown, not selectable; current +
   matches admin) vs **hide** it. _Recommend disable + grey._
4. **Publication id** — **env var** (recommend, explicit/auditable) vs query-on-boot.

**What you can verify on dev** (you have the markets + gift products and can toggle publish/stock):

- _E1:_ unpublish a gift from the Online Store → chooser greys it, **no 422** (proactive); re-publish →
  offered. Set a variant OOS → greyed; restock → offered. Confirm the previously-minted code is **reused**
  (no new `discountNode`) when it returns.
- _E2:_ same toggles → the editor row greys with the correct reason; refresh reflects a mid-session change.
- _E3:_ activate July with one tier-3 option unpublished → soft warning; an AND tier with one required gift
  unavailable → storefront shows the bundle greyed + note, `/validate` returns `gift-unavailable`.
