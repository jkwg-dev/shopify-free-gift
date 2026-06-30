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

// A reserved sentinel tag NO product carries — so `TAG NOT_EQUALS <sentinel>` matches ALL products
// (incl. gift products). This is the "anything qualifies" scope for the model-C inclusion flip
// (verified live: matched all products + gifts). BXGY rejects all-items customerBuys, so "anything"
// must still go through a collection — this rule is how.
export const QUALIFYING_SENTINEL_TAG = 'app:fge-nonqualifying';

export type QualifyingRule = {
  readonly column: string;
  readonly relation: string;
  readonly condition: string;
};

// EXCLUDE_GIFTS_RULE = today's behavior (gift-tagged products drop out). ALL_PRODUCTS_RULE = the
// model-C inclusion scope (everything, incl. gifts). The composition root picks one from the flag;
// this package stays flag-agnostic.
export const EXCLUDE_GIFTS_RULE: QualifyingRule = {
  column: 'TAG',
  relation: 'NOT_EQUALS',
  condition: GIFT_TAG,
};
export const ALL_PRODUCTS_RULE: QualifyingRule = {
  column: 'TAG',
  relation: 'NOT_EQUALS',
  condition: QUALIFYING_SENTINEL_TAG,
};

const COLLECTION_BY_HANDLE = `query QualifyingCollectionByHandle($handle: String!) {
  collectionByIdentifier(identifier: { handle: $handle }) { id handle }
}`;

const COLLECTION_CREATE = `mutation CreateQualifyingCollection($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id handle }
    userErrors { field message }
  }
}`;

const COLLECTION_UPDATE = `mutation UpdateQualifyingCollection($input: CollectionInput!) {
  collectionUpdate(input: $input) {
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
type UpdateResponse = {
  readonly collectionUpdate: {
    readonly collection: QualifyingCollection | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
};

export type EnsureQualifyingOptions = {
  // Smart-collection rule to apply. Defaults to EXCLUDE_GIFTS_RULE (today's behavior).
  readonly rule?: QualifyingRule;
  // When true, UPDATE an existing collection's ruleSet IN PLACE (collectionUpdate, keeps id/handle so
  // BXGY references don't break — verified live). When false (default), an existing collection is
  // returned untouched (today's behavior). Provisioning sets this true to flip the rule.
  readonly reconcileExisting?: boolean;
};

// Create-or-reuse the single shared qualifying smart collection (idempotent by handle). With no
// options this is exactly today's behavior (rule = EXCLUDE_GIFTS_RULE, existing returned as-is).
export async function ensureQualifyingCollection(
  client: AdminGraphqlClient,
  options: EnsureQualifyingOptions = {},
): Promise<QualifyingCollection> {
  const handle = QUALIFYING_COLLECTION_HANDLE;
  const rule = options.rule ?? EXCLUDE_GIFTS_RULE;
  const existing = await client.request<ByHandleResponse>(COLLECTION_BY_HANDLE, { handle });
  if (existing.collectionByIdentifier !== null) {
    if (options.reconcileExisting === true) {
      await updateCollectionRule(client, existing.collectionByIdentifier.id, rule);
    }
    return existing.collectionByIdentifier;
  }

  const data = await client.request<CreateResponse>(COLLECTION_CREATE, {
    input: {
      title: 'Free gift — qualifying products',
      handle,
      ruleSet: { appliedDisjunctively: false, rules: [rule] },
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

// Update an existing smart collection's ruleSet in place (id/handle preserved). Used to FLIP the
// qualifying rule between exclude-gifts and all-products without recreating the collection.
async function updateCollectionRule(
  client: AdminGraphqlClient,
  id: string,
  rule: QualifyingRule,
): Promise<void> {
  const data = await client.request<UpdateResponse>(COLLECTION_UPDATE, {
    input: { id, ruleSet: { appliedDisjunctively: false, rules: [rule] } },
  });
  if (data.collectionUpdate.userErrors.length > 0) {
    throw new ShopifyUserError(data.collectionUpdate.userErrors);
  }
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

// Inclusion counterpart of waitForGiftProductsExcluded (model-C flip): smart-collection membership
// settles ASYNCHRONOUSLY after the rule changes / a tag is removed, so before minting a code that
// references the collection we wait until every gift product is INCLUDED (hasProduct=true). Returns
// false on timeout — the caller must then NOT mint (a full-price gift purchase wouldn't yet qualify).
export async function waitForGiftProductsIncluded(
  client: AdminGraphqlClient,
  collectionId: string,
  giftProductIds: readonly string[],
  options: WaitOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? globalSleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let allIncluded = true;
    for (const productId of giftProductIds) {
      const data = await client.request<HasProductResponse>(COLLECTION_HAS_PRODUCT, {
        id: collectionId,
        productId,
      });
      if (data.collection?.hasProduct !== true) {
        allIncluded = false;
      }
    }
    if (allIncluded) {
      return true;
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return false;
}

const COLLECTION_TITLE = `query CollectionTitle($id: ID!) {
  collection(id: $id) { id title }
}`;

type TitleResponse = { readonly collection: { readonly title: string } | null };

export async function fetchCollectionTitle(
  client: AdminGraphqlClient,
  collectionId: string,
): Promise<string | null> {
  const data = await client.request<TitleResponse>(COLLECTION_TITLE, { id: collectionId });
  return data.collection?.title ?? null;
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

// Of the given gift PRODUCTS, which are STILL members of the qualifying collection (hasProduct=true)
// — i.e. NOT excluded. A non-empty result means those gifts are not tagged/excluded and would count
// toward their own qualifying spend (self-qualify leak). Used as a mint precondition: the membership
// effect is authoritative (an untagged product necessarily matches the NOT_EQUALS rule, so it is a
// member), so this catches both a missing tag and unsettled membership.
export async function giftProductsStillInCollection(
  client: AdminGraphqlClient,
  collectionId: string,
  giftProductIds: readonly string[],
): Promise<string[]> {
  const stillMembers: string[] = [];
  for (const productId of giftProductIds) {
    const data = await client.request<HasProductResponse>(COLLECTION_HAS_PRODUCT, {
      id: collectionId,
      productId,
    });
    if (data.collection?.hasProduct === true) {
      stillMembers.push(productId);
    }
  }
  return stillMembers;
}

// Check which of the given product GIDs are members of a collection. Returns the set of product GIDs
// that ARE members. Used by /validate to determine which cart lines fall inside the merchant-configured
// qualifying collection (tier qualification is scoped to collection members only).
export async function fetchCollectionMembership(
  client: AdminGraphqlClient,
  collectionId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  const members = new Set<string>();
  for (const productId of productIds) {
    const data = await client.request<HasProductResponse>(COLLECTION_HAS_PRODUCT, {
      id: collectionId,
      productId,
    });
    if (data.collection?.hasProduct === true) {
      members.add(productId);
    }
  }
  return members;
}
