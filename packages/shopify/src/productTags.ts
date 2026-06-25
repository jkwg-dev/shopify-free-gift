import type { AdminGraphqlClient } from './client.js';
import { GIFT_TAG } from './collections.js';
import { ShopifyUserError, type UserErrorDetail } from './errors.js';

// Tag/untag PRODUCTS with GIFT_TAG so they drop out of the qualifying smart collection.
// Two levels: by product id (what the admin tag-lifecycle guard uses — it reconciles at product
// granularity across active campaigns) and a variant convenience that resolves variants -> products
// first. Idempotent: tagsAdd no-ops an existing tag; tagsRemove no-ops an absent one. Tags are
// per-product, so tagging removes ALL of a product's variants from the qualifying scope.

const PRODUCT_IDS_FOR_VARIANTS = `query ProductIdsForVariants($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant { id product { id } }
  }
}`;

const TAGS_ADD = `mutation TagGiftProduct($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

const TAGS_REMOVE = `mutation UntagGiftProduct($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;

type VariantNode =
  | {
      readonly __typename: 'ProductVariant';
      readonly id: string;
      readonly product: { readonly id: string };
    }
  | { readonly __typename: string };

type NodesResponse = { readonly nodes: readonly (VariantNode | null)[] };
type TagsResponse = { readonly tagsAdd?: { readonly userErrors: readonly UserErrorDetail[] } };
type UntagResponse = { readonly tagsRemove?: { readonly userErrors: readonly UserErrorDetail[] } };

function isVariantNode(
  node: VariantNode | null,
): node is { __typename: 'ProductVariant'; id: string; product: { id: string } } {
  return node !== null && node.__typename === 'ProductVariant';
}

// Resolve gift variant GIDs to their owning product GIDs (de-duplicated).
export async function giftProductIdsForVariants(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
): Promise<string[]> {
  if (variantIds.length === 0) {
    return [];
  }
  const data = await client.request<NodesResponse>(PRODUCT_IDS_FOR_VARIANTS, { ids: variantIds });
  const productIds = new Set<string>();
  for (const node of data.nodes) {
    if (isVariantNode(node)) {
      productIds.add(node.product.id);
    }
  }
  return [...productIds];
}

export async function tagProductsAsGift(
  client: AdminGraphqlClient,
  productIds: readonly string[],
): Promise<void> {
  for (const id of productIds) {
    const data = await client.request<TagsResponse>(TAGS_ADD, { id, tags: [GIFT_TAG] });
    const errors = data.tagsAdd?.userErrors ?? [];
    if (errors.length > 0) {
      throw new ShopifyUserError(errors);
    }
  }
}

export async function untagProductsAsGift(
  client: AdminGraphqlClient,
  productIds: readonly string[],
): Promise<void> {
  for (const id of productIds) {
    const data = await client.request<UntagResponse>(TAGS_REMOVE, { id, tags: [GIFT_TAG] });
    const errors = data.tagsRemove?.userErrors ?? [];
    if (errors.length > 0) {
      throw new ShopifyUserError(errors);
    }
  }
}

const PRODUCT_TAGS = `query GiftProductTags($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Product { id tags }
  }
}`;

type ProductTagsNode =
  | { readonly __typename: 'Product'; readonly id: string; readonly tags: readonly string[] }
  | { readonly __typename: string };
type ProductTagsResponse = { readonly nodes: readonly (ProductTagsNode | null)[] };

// Re-read each product's tags and return the ids that are NOT actually carrying GIFT_TAG. Used as a
// post-tag verification: a silent failure (e.g. write_products not truly granted) can leave tagsAdd
// reporting no userErrors while the tag never persists, which would let a gift self-qualify. The
// caller treats a non-empty result as fatal (do not mint).
export async function giftProductsMissingTag(
  client: AdminGraphqlClient,
  productIds: readonly string[],
): Promise<string[]> {
  if (productIds.length === 0) {
    return [];
  }
  const data = await client.request<ProductTagsResponse>(PRODUCT_TAGS, { ids: productIds });
  const tagged = new Set<string>();
  for (const node of data.nodes) {
    if (node !== null && node.__typename === 'Product') {
      const product = node as { id: string; tags: readonly string[] };
      if (product.tags.includes(GIFT_TAG)) {
        tagged.add(product.id);
      }
    }
  }
  return productIds.filter((id) => !tagged.has(id));
}

// Variant convenience: resolve to owning products, then tag/untag them. Returns the product ids.
export async function tagGiftProducts(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
): Promise<readonly string[]> {
  const productIds = await giftProductIdsForVariants(client, variantIds);
  await tagProductsAsGift(client, productIds);
  return productIds;
}

export async function untagGiftProducts(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
): Promise<readonly string[]> {
  const productIds = await giftProductIdsForVariants(client, variantIds);
  await untagProductsAsGift(client, productIds);
  return productIds;
}
