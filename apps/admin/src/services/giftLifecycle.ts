// Gift-product tag lifecycle for the BXGY primitive. The qualifying smart collection is SHARED and
// the _fge_gift tag is effectively GLOBAL, so tagging/untagging must be reconciled across ALL active
// campaigns. Depends on an injected gateway (wired to packages/shopify at the composition root) so
// the ordering + guard logic is unit-testable without I/O.

export interface GiftTagGateway {
  // Create-or-reuse the shared qualifying smart collection; returns its GID.
  ensureQualifyingCollection(): Promise<{ readonly id: string }>;
  // Resolve gift variant GIDs to their owning product GIDs (de-duplicated).
  resolveGiftProductIds(variantIds: readonly string[]): Promise<readonly string[]>;
  tagProductsAsGift(productIds: readonly string[]): Promise<void>;
  untagProductsAsGift(productIds: readonly string[]): Promise<void>;
  // Poll until the gift products are excluded from the collection (membership is async).
  waitForGiftProductsExcluded(
    collectionId: string,
    productIds: readonly string[],
  ): Promise<boolean>;
}

export type ProvisionResult = {
  readonly collectionId: string;
  // false if the collection hasn't reflected the tags within the timeout — the caller MUST NOT
  // mint/activate codes that reference the collection yet (else a gift could self-qualify).
  readonly ready: boolean;
};

// Activation ordering (membership is async): ensure collection -> tag gift products -> WAIT until
// they're excluded -> only then is it safe to mint/activate the BXGY codes. Pass the union of gift
// variants across all active campaigns (the tag is global).
export async function provisionGifts(
  gateway: GiftTagGateway,
  activeGiftVariantIds: readonly string[],
): Promise<ProvisionResult> {
  const collection = await gateway.ensureQualifyingCollection();
  const productIds = await gateway.resolveGiftProductIds(activeGiftVariantIds);
  await gateway.tagProductsAsGift(productIds);
  const ready = await gateway.waitForGiftProductsExcluded(collection.id, productIds);
  return { collectionId: collection.id, ready };
}

// Teardown guard: when a campaign is removed/superseded, untag its gift products ONLY if no OTHER
// active campaign still uses that product as a gift. Removing the tag while another active campaign
// still gifts the product would re-add it to the qualifying collection and reintroduce the
// self-qualify leak. Returns the product GIDs actually untagged.
export async function reconcileGiftTagsOnTeardown(
  gateway: GiftTagGateway,
  removedGiftVariantIds: readonly string[],
  remainingActiveGiftVariantIds: readonly string[],
): Promise<readonly string[]> {
  const removedProducts = await gateway.resolveGiftProductIds(removedGiftVariantIds);
  const stillUsed = new Set(await gateway.resolveGiftProductIds(remainingActiveGiftVariantIds));
  const toUntag = removedProducts.filter((productId) => !stillUsed.has(productId));
  if (toUntag.length > 0) {
    await gateway.untagProductsAsGift(toUntag);
  }
  return toUntag;
}
