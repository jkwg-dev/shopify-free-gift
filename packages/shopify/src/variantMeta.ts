import type { AdminGraphqlClient } from './client.js';

// Presentation metadata for gift variants, for the read-only campaign-config endpoint (Phase 5b-2).
// The stored gift config holds only { id, variantId }; the chooser additionally needs the owning
// product id (to group sibling variants), a display label, and an image. Market-agnostic (no country)
// — pricing + availability come separately from contextualPricing. This is a pure read wrapper; the
// display label is derived by the caller (the config builder), keeping business logic out of this layer.

export type VariantMeta = {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  // The variant's own title: an option value ('Ice', 'L') for multi-variant products, or the
  // Shopify sentinel 'Default Title' for single-variant products. The caller decides the label.
  readonly variantTitle: string;
  // The variant's own image, else the product's featured image, else null (for the chooser cards).
  readonly imageUrl: string | null;
};

// Shopify caps nodes(ids:) at 250 per call; batch to stay within that.
const NODE_BATCH_SIZE = 250;

const VARIANT_META_QUERY = `query GiftVariantMeta($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      title
      image { url }
      product { id title featuredImage { url } }
    }
  }
}`;

type MetaNode =
  | {
      readonly __typename: 'ProductVariant';
      readonly id: string;
      readonly title: string;
      readonly image: { readonly url: string } | null;
      readonly product: {
        readonly id: string;
        readonly title: string;
        readonly featuredImage: { readonly url: string } | null;
      };
    }
  | { readonly __typename: string };

type MetaResponse = { readonly nodes: readonly (MetaNode | null)[] };
type VariantMetaNode = Extract<MetaNode, { __typename: 'ProductVariant' }>;

function isVariantNode(node: MetaNode | null): node is VariantMetaNode {
  return node !== null && node.__typename === 'ProductVariant';
}

// Resolve gift variant GIDs to their product id + titles + image. A variant that no longer resolves
// (deleted) is simply omitted; the config builder treats a missing entry as unavailable.
export async function fetchVariantMeta(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
): Promise<readonly VariantMeta[]> {
  if (variantIds.length === 0) {
    return [];
  }
  const out: VariantMeta[] = [];
  for (let i = 0; i < variantIds.length; i += NODE_BATCH_SIZE) {
    const batch = variantIds.slice(i, i + NODE_BATCH_SIZE);
    const data = await client.request<MetaResponse>(VARIANT_META_QUERY, { ids: batch });
    for (const node of data.nodes) {
      if (isVariantNode(node)) {
        out.push({
          id: node.id,
          productId: node.product.id,
          productTitle: node.product.title,
          variantTitle: node.title,
          imageUrl: node.image?.url ?? node.product.featuredImage?.url ?? null,
        });
      }
    }
  }
  return out;
}
