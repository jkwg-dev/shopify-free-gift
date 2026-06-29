import type { AdminGraphqlClient } from './client.js';
import type { GraphqlErrorDetail } from './errors.js';

// Channel + stock availability for gift variants (Stage E): the two signals that contextualPricing
// does NOT carry — Online-Store PUBLICATION and stock. Publication is read via
// product.publishedOnPublication(publicationId:), which requires `read_publications` (NOT read_products
// alone, and NOT publishedOnCurrentPublication which needs read_product_listings). Market-agnostic:
// publish + stock are not per-market. Pure read wrapper; the offerable decision is core.giftOfferability.
//
// TWO resilience layers (see docs/phase-3b-stage-e-channel-availability-design.md §5b/§5c):
//   1. PARTIAL-TOLERANT — a field error on ONE node of a nodes(ids:) batch nulls only that node, but a
//      strict client throwing on any errors[] would discard the WHOLE batch and grey every gift. We use
//      client.requestPartial so a single bad node OMITS ONLY ITSELF (the caller greys exactly that gift).
//   2. MISSING-SCOPE FALLBACK — if the app lacks `read_publications`, EVERY publishedOnPublication read
//      is ACCESS_DENIED (the node nulls, so availableForSale is lost from this query too). We detect that
//      and fall back to STOCK-ONLY (pre-E1 behavior): re-read availableForSale alone and DON'T let
//      publication gate. Never grey-all on a pure scope gap; surface it loudly instead (re-consent fixes
//      it). A real publishedOnPublication=false (not an error) still greys exactly that gift — the two
//      are never conflated.

export type GiftChannelAvailability = {
  // ProductVariant.availableForSale — sellability/stock, respecting the variant's inventory policy.
  readonly availableForSale: boolean;
  // Whether the OWNING product is published to the supplied (Online Store) publication. In the
  // missing-scope fallback this is forced `true` so publication does not gate (stock-only).
  readonly publishedToOnlineStore: boolean;
};

// Shopify caps nodes(ids:) at 250 per call; batch to stay within that.
const NODE_BATCH_SIZE = 250;

// Combined read: stock + Online-Store publish status. publishedOnPublication needs read_publications.
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

// Stock-only read (read_products): the missing-scope fallback. publishedOnPublication is omitted, so it
// cannot ACCESS_DENY — availableForSale always resolves. (The combined query's ACCESS_DENIED nulls the
// whole node, taking availableForSale with it, which is why stock must be re-read here.)
const STOCK_ONLY_QUERY = `query GiftStock($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      availableForSale
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

type StockNode =
  | {
      readonly __typename: 'ProductVariant';
      readonly id: string;
      readonly availableForSale: boolean;
    }
  | { readonly __typename: string };

type ChannelResponse = { readonly nodes: readonly (ChannelNode | null)[] };
type StockResponse = { readonly nodes: readonly (StockNode | null)[] };
type VariantChannelNode = Extract<ChannelNode, { __typename: 'ProductVariant' }>;
type VariantStockNode = Extract<StockNode, { __typename: 'ProductVariant' }>;

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

function isStockNode(node: StockNode | null): node is VariantStockNode {
  return node !== null && node.__typename === 'ProductVariant';
}

// A scope gap (NOT a per-gift publish state): the app lacks read_publications, so publishedOnPublication
// is denied. Distinguished from a real publishedOnPublication=false (which is a value, not an error) and
// from an unrelated per-node error. Matches the ACCESS_DENIED code OR the access-scope message, on a path
// ending in publishedOnPublication (Shopify carries the reason in extensions.code and/or the message).
function isPublicationScopeDenied(errors: readonly GraphqlErrorDetail[]): boolean {
  return errors.some((e) => {
    const onPublication =
      e.path !== undefined && e.path[e.path.length - 1] === 'publishedOnPublication';
    const denied = e.code === 'ACCESS_DENIED' || /access denied|access scope/i.test(e.message);
    return onPublication && denied;
  });
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
  let warnedScopeMissing = false; // one loud warning per request, not per batch.
  for (let i = 0; i < variantIds.length; i += NODE_BATCH_SIZE) {
    const batch = variantIds.slice(i, i + NODE_BATCH_SIZE);
    const { data, errors } = await client.requestPartial<ChannelResponse>(
      CHANNEL_AVAILABILITY_QUERY,
      { ids: batch, publicationId },
    );

    // Missing read_publications -> publication unreadable for the whole batch. Fall back to stock-only
    // (pre-E1) rather than greying every gift; re-consent (reinstall) restores publication greying.
    if (isPublicationScopeDenied(errors)) {
      if (!warnedScopeMissing) {
        console.warn(
          '[channelAvailability] read_publications missing; falling back to stock-only. Re-consent required.',
        );
        warnedScopeMissing = true;
      }
      const { data: stockData } = await client.requestPartial<StockResponse>(STOCK_ONLY_QUERY, {
        ids: batch,
      });
      for (const node of stockData?.nodes ?? []) {
        if (isStockNode(node)) {
          // publishedToOnlineStore forced true so the predicate does NOT gate on publication.
          out.set(node.id, {
            availableForSale: node.availableForSale,
            publishedToOnlineStore: true,
          });
        }
      }
      continue;
    }

    if (errors.length > 0) {
      // A genuine per-node error (NOT a scope gap): the failing node is null/product-null in `data`, so
      // isVariantNode below omits ONLY it and the caller greys exactly that gift. error-level + the
      // response path captures the exact payload for triage.
      console.error(
        '[channelAvailability] partial GraphQL errors reading gift publish status; affected gifts greyed',
        errors,
      );
    }
    for (const node of data?.nodes ?? []) {
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
