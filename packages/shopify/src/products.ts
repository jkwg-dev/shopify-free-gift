import type { AdminGraphqlClient } from './client.js';
import { GiftVariantValidationError } from './errors.js';

export type GiftVariant = {
  readonly id: string;
  readonly title: string;
  readonly availableForSale: boolean;
  // Decimal price string + currency, exactly as Shopify returns it. Conversion to core Money
  // (if needed) goes through ./money, the currency-exponent boundary.
  readonly price: string;
  readonly product: { readonly id: string; readonly title: string; readonly status: string };
};

// Shopify caps `nodes(ids:)` at 250 ids per call; batch to stay within that and avoid N+1.
const NODE_BATCH_SIZE = 250;

const VARIANTS_QUERY = `query GiftVariants($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      title
      availableForSale
      price
      product { id title status }
    }
  }
}`;

type VariantNode =
  | ({ readonly __typename: 'ProductVariant' } & GiftVariant)
  | { readonly __typename: string };

type VariantsResponse = {
  readonly nodes: readonly (VariantNode | null)[];
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function isProductVariant(
  node: VariantNode | null,
): node is { readonly __typename: 'ProductVariant' } & GiftVariant {
  return node !== null && node.__typename === 'ProductVariant';
}

// Fetch and validate gift variants in batches. Throws GiftVariantValidationError listing every
// id that did not resolve to a live ProductVariant (deleted, wrong type, or unknown gid), so a
// campaign can never be configured against a phantom gift.
export async function fetchGiftVariants(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
): Promise<GiftVariant[]> {
  if (variantIds.length === 0) {
    return [];
  }

  const found = new Map<string, GiftVariant>();
  for (const batch of chunk(variantIds, NODE_BATCH_SIZE)) {
    const data = await client.request<VariantsResponse>(VARIANTS_QUERY, { ids: batch });
    for (const node of data.nodes) {
      if (isProductVariant(node)) {
        found.set(node.id, {
          id: node.id,
          title: node.title,
          availableForSale: node.availableForSale,
          price: node.price,
          product: node.product,
        });
      }
    }
  }

  const invalidIds = variantIds.filter((id) => !found.has(id));
  if (invalidIds.length > 0) {
    throw new GiftVariantValidationError(invalidIds);
  }
  // Preserve the caller's order.
  return variantIds.map((id) => found.get(id) as GiftVariant);
}
