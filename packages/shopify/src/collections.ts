import type { AdminGraphqlClient } from './client.js';
import { ShopifyUserError, type UserErrorDetail } from './errors.js';

// SINGLE SOURCE for the gift product tag — used BOTH to tag gift products AND as the
// smart-collection rule condition. If these ever diverge the collection stops excluding gifts and
// the self-qualify leak returns, so they MUST reference this one constant. Uses the Shopify
// `app:` reserved-tag convention (hidden from the merchant UI). Verified live: tagsAdd applies it
// and `TAG NOT_EQUALS "app:fge_gift"` excludes the tagged product.
// Granularity is per-PRODUCT (tagging removes ALL of a product's variants from the qualifying
// scope) — gift products MUST be distinct from qualifying products. NOTE: this is the product TAG,
// SEPARATE from core's GIFT_LINE_PROPERTY (the cart-line property the widget reconciler uses).
export const GIFT_TAG = 'app:fge_gift';

export type QualifyingCollection = { readonly id: string; readonly handle: string };

// Smart-collection rule "tag NOT_EQUALS app:fge_gift" auto-includes every non-gift product (verified
// supported: CollectionRuleColumn.TAG + CollectionRuleRelation.NOT_EQUALS). The rule is
// campaign-independent, so ONE SHARED collection serves every campaign/tier (looked up by this
// deterministic handle for idempotency).
export const QUALIFYING_COLLECTION_HANDLE = 'fge-qualifying';

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

// Create-or-reuse the single shared qualifying smart collection (idempotent by handle). The
// collection auto-includes all products NOT tagged GIFT_TAG.
export async function ensureQualifyingCollection(
  client: AdminGraphqlClient,
): Promise<QualifyingCollection> {
  const handle = QUALIFYING_COLLECTION_HANDLE;
  const existing = await client.request<ByHandleResponse>(COLLECTION_BY_HANDLE, { handle });
  if (existing.collectionByIdentifier !== null) {
    return existing.collectionByIdentifier;
  }

  const data = await client.request<CreateResponse>(COLLECTION_CREATE, {
    input: {
      title: 'Free gift — qualifying products',
      handle,
      ruleSet: {
        appliedDisjunctively: false,
        rules: [{ column: 'TAG', relation: 'NOT_EQUALS', condition: GIFT_TAG }],
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

const COLLECTION_PRODUCT_COUNT = `query QualifyingCollectionProductCount($id: ID!) {
  collection(id: $id) { id productsCount { count } }
}`;

type ProductCountResponse = {
  readonly collection: { readonly productsCount: { readonly count: number } } | null;
};

// Number of products in the collection, or null if the collection doesn't exist. Used as the mint
// precondition (refuse to mint a BXGY code against a missing or EMPTY qualifying scope).
export async function collectionProductCount(
  client: AdminGraphqlClient,
  collectionId: string,
): Promise<number | null> {
  const data = await client.request<ProductCountResponse>(COLLECTION_PRODUCT_COUNT, {
    id: collectionId,
  });
  return data.collection === null ? null : data.collection.productsCount.count;
}
