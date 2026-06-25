# Phase 5b — re-seed / re-provision runbook (BXGY + write_products)

This runbook recovers from the **$0 leak** and switches the gift primitive to **BXGY** with a real,
verified qualifying scope. It is the corrected ordering: **reinstall → deactivate old codes →
provision (hard-fails) → verify → only then mint.**

## Root cause (why this runbook exists)

The original codes were `discountCodeBasic` "amount off the gift", whose minimum is measured against
the **discounted gift itself**, so the gift self-qualified → always **$0** regardless of cart.

The BXGY rework moved the threshold onto a separate **qualifying smart collection**
(`customerBuys`), but provisioning **silently failed**: `write_products` was not actually granted, so
`tagsAdd` (tag gift products) and `collectionCreate` (the `fge-qualifying` collection) were no-ops.
The collection **did not exist** and the gift product carried **no tag**, so `customerBuys`
referenced an empty/missing scope → threshold void → **still $0.**

The code fix makes this class of failure **fatal** instead of silent:

- `provisionGifts` (apps/admin `services/giftLifecycle.ts`) now **throws `GiftProvisioningError`** if
  the collection is missing/empty, gift variants resolve to no products, the tag did not persist
  (post-tag re-read), or membership did not settle.
- `createScopedGiftDiscount` (packages/shopify `discounts.ts`) queries the collection's product count
  **before** `discountCodeBxgyCreate` and **refuses to mint** (`EmptyQualifyingScopeError`) when the
  qualifying collection is **missing or empty**. It never mints against an empty scope.

The gift product **tag** is the single constant `GIFT_TAG = 'app:fge_gift'` (packages/shopify
`collections.ts`), used in BOTH the tagging mutation AND the smart-collection rule
`TAG NOT_EQUALS app:fge_gift`. **Verified live:** the `app:` colon works in the `NOT_EQUALS` rule —
the collection accepted the rule, `tagsAdd` applied `["app:fge_gift"]`, and after async membership
settled the tagged product left the collection (count 17 → 16) while an untagged control stayed in.

> **NOT the same string:** core's `GIFT_LINE_PROPERTY = '_fge_gift'` is the **cart-line property** the
> storefront widget uses to mark app-added gift lines. It is a different mechanism from the product
> TAG and is intentionally left unchanged.

## Pre-req — reinstall for `write_products`

`[access_scopes]` in `shopify.app.toml` now includes **`write_products`**
(`read_products,write_products,write_discounts,read_discounts`). A scope change requires
**re-consent**: the merchant must **reinstall** (open the install link and approve) so the new offline
token carries `write_products`. Until then tagging + collection creation will fail and provisioning
will (correctly) hard-fail.

Confirm the granted scopes on the live token before proceeding:

```graphql
{
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}
```

`write_products` MUST appear. If it doesn't, the reinstall didn't take — stop here.

## Step 1 — deactivate the old leaky codes + campaign

Both the old `discountCodeBasic` codes AND any `discountCodeBxgy` codes minted against the
missing/empty scope are leaky. Deactivate them (codes are immutable; deactivate is the only path) and
deactivate the old campaign so `/validate` won't re-mint against stale state.

- List the app's discount codes and deactivate each leaky one via `discountCodeDeactivate(id:)`
  (type-agnostic — handles basic + bxgy). Clear the `GiftCodeMapping` rows so a fresh mint is forced.
- Set the seeded campaign inactive (or re-run the idempotent seed, which replaces the shop's
  campaigns) so a single clean active campaign remains.

### Dangling gift-code reservations (the "Timed out waiting…" symptom)

`/validate` mints under a reserve-then-mint model: it reserves a `GiftCodeMapping` row (code NULL),
then mints. Before the lifecycle fix, a mint that **aborted** (now `EmptyQualifyingScopeError`,
because the qualifying collection is missing/empty) could leave a **reservation that never resolved**;
the next caller then waited on it and failed with `Timed out waiting for a concurrent gift-code
creation to resolve` — masking the real cause.

Fixed in `store/giftCodeMapping.ts`: any mint failure **releases the reservation** before the error
propagates, and a waiter that sees the holder fail/abandon **takes over and re-mints**, so the caller
now surfaces the REAL error (empty qualifying scope → "reinstall + re-seed to create the qualifying
collection") and fails fast instead of timing out. A reservation older than `staleReservationMs`
(60s) is reclaimed automatically, so a pre-existing zombie self-heals on the next call.

To clear zombies explicitly:

- **Re-seeding already does it:** `seed:smoke` runs `campaign.deleteMany`, which **cascades** to
  `gift_code_mappings` (`onDelete: Cascade`) — every reservation under the old campaign is removed.
  Re-seed is therefore idempotent w.r.t. stale reservations.
- **Without re-seeding** (unwedge the current campaign): `pnpm --filter @free-gift-engine/admin run
clear:reservations` (env `SHOPIFY_SHOP_DOMAIN`, `DATABASE_URL`/`DIRECT_URL`). It deletes only
  unresolved rows (code IS NULL) older than `STALE_MINUTES` (default 2); finalized/active codes are
  untouched.

## Step 2 — provision (this now HARD-FAILS on a broken scope)

Provisioning is the ordered, fail-loud sequence in `provisionGifts`:

1. `ensureQualifyingCollection` — create-or-reuse the shared `fge-qualifying` smart collection
   (rule `TAG NOT_EQUALS app:fge_gift`).
2. `resolveGiftProductIds` — gift **variant** GIDs → owning **product** GIDs (deduped). Throws
   `no-products-resolved` if nothing resolves.
3. `tagProductsAsGift` — `tagsAdd app:fge_gift` on each gift product.
4. **Verify the tag persisted** (`giftProductsMissingTag` re-reads tags). Any product still missing
   the tag → `GiftProvisioningError('tag-not-applied')` ("write_products likely not granted —
   reinstall required"). This catches the exact silent failure that caused the leak.
5. `waitForGiftProductsExcluded` — poll until the gift products leave the collection (membership is
   async). Not settled → `GiftProvisioningError('membership-not-confirmed')`.
6. `collectionProductCount` — confirm the qualifying scope is **real and non-empty**. Missing →
   `collection-missing`; zero → `collection-empty`.

On success it returns `{ collectionId, taggedProductIds, qualifyingProductCount, ready: true }`.

> **Per-product tag granularity:** tagging a gift product removes **all** its variants from the
> qualifying scope. Gift products MUST be distinct from the qualifying paid product. On greentee-dev
> the qualifying paid item is **The Collection Snowboard: Hydrogen**
> (`gid://shopify/ProductVariant/44289298235501`) — a different product from every gift, so it stays
> in scope. Verify this holds before minting.

## Step 3 — verify, then PRINT (collection id + membership + tagged products)

Before any mint, confirm and record all three:

```graphql
# (a) collection exists + is non-empty (qualifying scope is real)
query {
  collectionByIdentifier(identifier: { handle: "fge-qualifying" }) {
    id
    handle
    productsCount {
      count
    }
  }
}

# (b) the qualifying paid product is IN scope (Hydrogen must remain a member)
query ($id: ID!, $product: ID!) {
  collection(id: $id) {
    hasProduct(id: $product)
  }
}
#   -> hasProduct(Hydrogen) == true

# (c) each gift product is tagged app:fge_gift AND excluded from the collection
query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      title
      tags
    }
  }
}
#   -> tags includes "app:fge_gift"
query ($id: ID!, $gift: ID!) {
  collection(id: $id) {
    hasProduct(id: $gift)
  }
}
#   -> hasProduct(gift) == false
```

Print for the record: **collection id**, **productsCount**, **hasProduct(Hydrogen)=true**, and the
**tagged gift product ids** (with `tags`). If any of these is off — collection missing/empty, a gift
untagged, or Hydrogen excluded — **do not mint**; provisioning / the mint precondition will (and
should) abort.

## Step 4 — mint (only now)

Hit `/validate` for each tier (see `docs/phase-4-smoke-test.md` → "Calling /validate during the
walk"). `createScopedGiftDiscount` re-checks the qualifying collection's product count and **refuses**
to call `discountCodeBxgyCreate` if it is missing or empty, so a mint can only succeed against a
verified, non-empty scope. Confirm in the Shopify admin that each minted code is **BXGY**
(`customerBuys` = amount on `fge-qualifying`, `customerGets` = the gift variant(s) at 100% off).

Then resume the Phase 4 / 5b walks: cross threshold → gift `$0`; **drop below** → gift reverts to
paid (the real BXGY backstop, now that `customerBuys` is a true qualifying scope); lower-tier gift
left in cart → charged full price.
