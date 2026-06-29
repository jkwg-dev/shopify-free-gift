import type { AdminGraphqlClient } from './client.js';

// Channel + stock availability for gift variants (Stage E): the two signals that contextualPricing
// does NOT carry — Online-Store PUBLICATION and stock. Publication is read via
// product.publishedOnPublication(publicationId:), which needs only `read_products` (NOT
// publishedOnCurrentPublication, which requires read_product_listings). Market-agnostic: publish +
// stock are not per-market. A pure read wrapper; the offerable decision lives in core.giftOfferability.
//
// PARTIAL-TOLERANT (see docs/phase-3b-stage-e-channel-availability-design.md §5b): a field-level
// GraphQL error on ONE node of the `nodes(ids:)` batch nulls only that node (the error propagates to
// the nullable list element), but a strict client that throws on any errors[] would discard the WHOLE
// batch and grey every gift. We use client.requestPartial so a single bad node OMITS ONLY ITSELF
// (isVariantNode skips it -> the caller greys exactly that gift via the missing-entry default); the
// surviving gifts keep their real publish/stock booleans. Errors are LOGGED, never swallowed.

export type GiftChannelAvailability = {
  // ProductVariant.availableForSale — sellability/stock, respecting the variant's inventory policy.
  readonly availableForSale: boolean;
  // Whether the OWNING product is published to the supplied (Online Store) publication.
  readonly publishedToOnlineStore: boolean;
};

// Shopify caps nodes(ids:) at 250 per call; batch to stay within that.
const NODE_BATCH_SIZE = 250;

const CHANNEL_AVAILABILITY_QUERY = `query GiftChannelAvailability($ids: [ID!]!, $publicationId: ID!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      availableForSale
      product { publishedOnPublication(publicationId: $publicationId) }
    }
  }
}`;

type ChannelNode =
  | {
      readonly __typename: 'ProductVariant';
      readonly id: string;
      readonly availableForSale: boolean;
      readonly product: { readonly publishedOnPublication: boolean };
    }
  | { readonly __typename: string };

type ChannelResponse = { readonly nodes: readonly (ChannelNode | null)[] };
type VariantChannelNode = Extract<ChannelNode, { __typename: 'ProductVariant' }>;

// Defensive: require the nested `product` to be present. A partial GraphQL error could null it while
// still returning the node — skipping it (rather than dereferencing null) keeps the read from throwing;
// a missing entry is treated by callers as not-offerable (fail closed).
function isVariantNode(node: ChannelNode | null): node is VariantChannelNode {
  return (
    node !== null &&
    node.__typename === 'ProductVariant' &&
    (node as VariantChannelNode).product != null
  );
}

// Read per-variant stock + per-product Online-Store publish status for the given gift variants.
// `publicationId` is the Online Store publication GID. A variant that no longer resolves is simply
// OMITTED from the map (the caller treats a missing entry as unavailable, mirroring fetchVariantMeta /
// fetchVariantPricing). Returned as a Map keyed by variant GID; caller order is not guaranteed.
export async function fetchGiftChannelAvailability(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
  publicationId: string,
): Promise<Map<string, GiftChannelAvailability>> {
  const out = new Map<string, GiftChannelAvailability>();
  if (variantIds.length === 0) {
    return out;
  }
  for (let i = 0; i < variantIds.length; i += NODE_BATCH_SIZE) {
    const batch = variantIds.slice(i, i + NODE_BATCH_SIZE);
    const { data, errors } = await client.requestPartial<ChannelResponse>(
      CHANNEL_AVAILABILITY_QUERY,
      { ids: batch, publicationId },
    );
    const nodes = data?.nodes ?? [];
    if (errors.length > 0) {
      // Never silent. Log WHICH nodes failed (errors carry the response path). error-level on purpose:
      // a properly-scoped read_products token returns a clean boolean for every gift, so any error here
      // is worth investigating (and captures the exact payload for triage). The failing node is
      // null/product-null in `data`, so isVariantNode below omits ONLY it; the caller greys that gift.
      console.error(
        '[channelAvailability] partial GraphQL errors reading gift publish status; affected gifts greyed',
        errors,
      );
    }
    for (const node of nodes) {
      if (isVariantNode(node)) {
        out.set(node.id, {
          availableForSale: node.availableForSale,
          publishedToOnlineStore: node.product.publishedOnPublication,
        });
      }
    }
  }
  return out;
}
