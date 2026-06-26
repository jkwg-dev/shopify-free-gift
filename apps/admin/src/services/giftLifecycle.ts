// Gift-product tag lifecycle for the BXGY primitive. The qualifying smart collection is SHARED and
// the app:fge_gift tag is effectively GLOBAL, so tagging/untagging must be reconciled across ALL
// active campaigns. Depends on an injected gateway (wired to packages/shopify at the composition
// root) so the ordering + guard logic is unit-testable without I/O.

export interface GiftTagGateway {
  // Create-or-reuse the shared qualifying smart collection; returns its GID.
  ensureQualifyingCollection(): Promise<{ readonly id: string }>;
  // Resolve gift variant GIDs to their owning product GIDs (de-duplicated).
  resolveGiftProductIds(variantIds: readonly string[]): Promise<readonly string[]>;
  tagProductsAsGift(productIds: readonly string[]): Promise<void>;
  untagProductsAsGift(productIds: readonly string[]): Promise<void>;
  // Re-read product tags; returns the product GIDs that do NOT actually carry the gift tag. A
  // non-empty result means tagging silently failed (e.g. write_products not truly granted).
  verifyGiftProductsTagged(productIds: readonly string[]): Promise<readonly string[]>;
  // Product count of the shared collection, or null if it does not exist.
  collectionProductCount(collectionId: string): Promise<number | null>;
  // Poll until the gift products are excluded from the collection (membership is async).
  waitForGiftProductsExcluded(
    collectionId: string,
    productIds: readonly string[],
  ): Promise<boolean>;
  // Inclusion counterpart (model-C flip): poll until the gift products are INCLUDED in the collection.
  waitForGiftProductsIncluded(
    collectionId: string,
    productIds: readonly string[],
  ): Promise<boolean>;
}

// Model-C flip option. Default (omitted/false) = today's EXCLUSION provisioning. When true, gift
// products are provisioned to be INCLUDED in the qualifying collection (un-tag + wait-for-inclusion);
// the collection's rule is flipped to ALL_PRODUCTS by the gateway's ensureQualifyingCollection.
export type ProvisionOptions = { readonly giftsIncluded?: boolean };

// Provisioning failed in a way that would let a gift self-qualify ($0 leak) if we minted anyway.
// Thrown by provisionGifts — the caller MUST NOT mint/activate any BXGY code when this is raised.
export class GiftProvisioningError extends Error {
  constructor(
    readonly reason:
      | 'collection-missing'
      | 'collection-empty'
      | 'no-products-resolved'
      | 'tag-not-applied'
      | 'membership-not-confirmed',
    message: string,
  ) {
    super(message);
    this.name = 'GiftProvisioningError';
  }
}

export type ProvisionResult = {
  readonly collectionId: string;
  // The gift product GIDs confirmed tagged + excluded. Always non-empty on success; printed by the
  // re-seed runbook for verification.
  readonly taggedProductIds: readonly string[];
  // Qualifying products remaining in the collection (gifts excluded). Always > 0 on success.
  readonly qualifyingProductCount: number;
  // Always true on success — provisionGifts THROWS rather than returning a not-ready result, so a
  // caller that receives a result can safely mint.
  readonly ready: true;
};

// Activation ordering (membership is async): ensure collection -> tag gift products -> VERIFY the
// tag actually persisted -> WAIT until they're excluded -> CONFIRM the qualifying scope is real and
// non-empty -> only then is it safe to mint/activate the BXGY codes. Pass the union of gift variants
// across all active campaigns (the tag is global).
//
// HARD-FAILS (throws GiftProvisioningError, never mints against a broken scope) when: the collection
// doesn't exist or is empty, gift variants resolve to no products, the tag didn't persist (likely
// write_products not granted — reinstall required), or membership didn't settle in time. Permission
// failures from the gateway (HTTP 403 / GraphQL access-denied) are not swallowed — they propagate.
export async function provisionGifts(
  gateway: GiftTagGateway,
  activeGiftVariantIds: readonly string[],
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  // The gateway's ensureQualifyingCollection applies the rule for the active model (exclude vs all) and
  // reconciles an existing collection's rule when flipping — wired at the composition root.
  const collection = await gateway.ensureQualifyingCollection();

  const productIds = await gateway.resolveGiftProductIds(activeGiftVariantIds);
  if (activeGiftVariantIds.length > 0 && productIds.length === 0) {
    throw new GiftProvisioningError(
      'no-products-resolved',
      `None of the ${activeGiftVariantIds.length} gift variant(s) resolved to a product — ` +
        `cannot tag or scope gifts.`,
    );
  }

  if (options.giftsIncluded === true) {
    // INCLUSION model: gifts must be MEMBERS. Remove the exclusion tag (migration) and wait until the
    // (now all-products) rule includes them. No tag-persist check — we are removing the tag.
    await gateway.untagProductsAsGift(productIds);
    const included = await gateway.waitForGiftProductsIncluded(collection.id, productIds);
    if (!included) {
      throw new GiftProvisioningError(
        'membership-not-confirmed',
        `Gift products are not yet included in collection ${collection.id} — membership did not ` +
          `settle in time. Refusing to mint (a full-price gift purchase would not yet qualify).`,
      );
    }
  } else {
    // EXCLUSION model (today): tag gifts out of the collection and wait until they're excluded.
    await gateway.tagProductsAsGift(productIds);
    const missingTag = await gateway.verifyGiftProductsTagged(productIds);
    if (missingTag.length > 0) {
      throw new GiftProvisioningError(
        'tag-not-applied',
        `Gift tag did not persist on ${missingTag.length} product(s): ${missingTag.join(', ')} — ` +
          `write_products likely not granted; reinstall required. Refusing to mint.`,
      );
    }
    const ready = await gateway.waitForGiftProductsExcluded(collection.id, productIds);
    if (!ready) {
      throw new GiftProvisioningError(
        'membership-not-confirmed',
        `Gift products are not yet excluded from collection ${collection.id} — membership did not ` +
          `settle in time. Refusing to mint (a gift could self-qualify).`,
      );
    }
  }

  const qualifyingProductCount = await gateway.collectionProductCount(collection.id);
  if (qualifyingProductCount === null) {
    throw new GiftProvisioningError(
      'collection-missing',
      `Qualifying collection ${collection.id} does not exist — provisioning failed (check ` +
        `write_products / collection creation). Refusing to mint.`,
    );
  }
  if (qualifyingProductCount === 0) {
    throw new GiftProvisioningError(
      'collection-empty',
      `Qualifying collection ${collection.id} is empty — no qualifying products, threshold would ` +
        `be void. Refusing to mint.`,
    );
  }

  return {
    collectionId: collection.id,
    taggedProductIds: productIds,
    qualifyingProductCount,
    ready: true,
  };
}

// Teardown guard: when a campaign is removed/superseded, untag its gift products ONLY if no OTHER
// active campaign still uses that product as a gift. Removing the tag while another active campaign
// still gifts the product would re-add it to the qualifying collection and reintroduce the
// self-qualify leak. Returns the product GIDs actually untagged.
export async function reconcileGiftTagsOnTeardown(
  gateway: GiftTagGateway,
  removedGiftVariantIds: readonly string[],
  remainingActiveGiftVariantIds: readonly string[],
  options: ProvisionOptions = {},
): Promise<readonly string[]> {
  // INCLUSION model: there is no exclusion tag to reconcile (gifts are members on purpose) — no-op.
  if (options.giftsIncluded === true) {
    return [];
  }
  const removedProducts = await gateway.resolveGiftProductIds(removedGiftVariantIds);
  const stillUsed = new Set(await gateway.resolveGiftProductIds(remainingActiveGiftVariantIds));
  const toUntag = removedProducts.filter((productId) => !stillUsed.has(productId));
  if (toUntag.length > 0) {
    await gateway.untagProductsAsGift(toUntag);
  }
  return toUntag;
}
