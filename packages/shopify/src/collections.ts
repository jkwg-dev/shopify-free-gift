import type { AdminGraphqlClient } from './client.js';
import { ShopifyUserError, type UserErrorDetail } from './errors.js';

// Product tag that marks a GIFT product, EXCLUDED from the qualifying (BXGY customerBuys) scope.
// Granularity is per-PRODUCT (Shopify tags are per product), so tagging a product removes ALL its
// variants from the qualifying collection — gift products MUST be distinct from qualifying products
// (a campaign-design constraint). This is a product tag, distinct from core's GIFT_LINE_PROPERTY
// cart-line marker (same string, different mechanism).
export const GIFT_PRODUCT_TAG = '_fge_gift';

export type QualifyingCollection = { readonly id: string; readonly handle: string };

// Smart-collection rule "tag NOT_EQUALS _fge_gift" auto-includes every non-gift product (verified
// supported: CollectionRuleColumn.TAG + CollectionRuleRelation.NOT_EQUALS). One collection per
// campaign, looked up by a deterministic handle for idempotency. (The rule is campaign-independent,
// so all campaigns' collections are effectively identical — see the Step 1 report.)
export function qualifyingCollectionHandle(campaignId: string): string {
  return `fge-qualifying-${campaignId}`;
}

const COLLECTION_BY_HANDLE = `query QualifyingCollectionByHandle($handle: String!) {
  collectionByIdentifier(identifier: { handle: $handle }) { id handle }
}`;

const COLLECTION_CREATE = `mutation CreateQualifyingCollection($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id handle }
    userErrors { field message }
  }
}`;

type ByHandleResponse = { readonly collectionByIdentifier: QualifyingCollection | null };
type CreateResponse = {
  readonly collectionCreate: {
    readonly collection: QualifyingCollection | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
};

// Create-or-reuse the campaign's qualifying smart collection (idempotent by handle). The collection
// auto-includes all products NOT tagged GIFT_PRODUCT_TAG.
export async function ensureQualifyingCollection(
  client: AdminGraphqlClient,
  campaignId: string,
): Promise<QualifyingCollection> {
  const handle = qualifyingCollectionHandle(campaignId);
  const existing = await client.request<ByHandleResponse>(COLLECTION_BY_HANDLE, { handle });
  if (existing.collectionByIdentifier !== null) {
    return existing.collectionByIdentifier;
  }

  const data = await client.request<CreateResponse>(COLLECTION_CREATE, {
    input: {
      title: `Free gift — qualifying products (${campaignId})`,
      handle,
      ruleSet: {
        appliedDisjunctively: false,
        rules: [{ column: 'TAG', relation: 'NOT_EQUALS', condition: GIFT_PRODUCT_TAG }],
      },
    },
  });
  const result = data.collectionCreate;
  if (result.userErrors.length > 0) {
    throw new ShopifyUserError(result.userErrors);
  }
  if (result.collection === null) {
    throw new ShopifyUserError([{ message: 'collectionCreate returned no collection' }]);
  }
  return result.collection;
}

const COLLECTION_HAS_PRODUCT = `query QualifyingCollectionHasProduct($id: ID!, $productId: ID!) {
  collection(id: $id) { id hasProduct(id: $productId) }
}`;

type HasProductResponse = { readonly collection: { readonly hasProduct: boolean } | null };

export type WaitOptions = {
  readonly attempts?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const globalSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(resolve, ms);
  });

// Smart-collection membership updates ASYNCHRONOUSLY after tagging, so a code that references the
// collection must not be activated until the gift products are actually excluded. Polls
// collection.hasProduct for each gift product until all are excluded (false). Returns false on
// timeout — the caller must then NOT activate the code (avoid a window where a gift self-qualifies).
export async function waitForGiftProductsExcluded(
  client: AdminGraphqlClient,
  collectionId: string,
  giftProductIds: readonly string[],
  options: WaitOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? globalSleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let allExcluded = true;
    for (const productId of giftProductIds) {
      const data = await client.request<HasProductResponse>(COLLECTION_HAS_PRODUCT, {
        id: collectionId,
        productId,
      });
      if (data.collection?.hasProduct === true) {
        allExcluded = false;
      }
    }
    if (allExcluded) {
      return true;
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return false;
}
