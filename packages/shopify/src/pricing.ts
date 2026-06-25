import type { AdminGraphqlClient } from './client.js';

// Authoritative, presentment-currency pricing + availability for cart and gift variants. /validate
// must recompute the qualifying subtotal from server-sourced prices (never client-posted ones) and
// must evaluate in the buyer's presentment currency (the market's resolvedThreshold currency, per
// the CLAUDE.md FX decision). contextualPricing(context: { country }) returns exactly that: the
// price Shopify would charge in that market, plus the variant's availability for the gift-stock gate.

export type VariantPricing = {
  readonly id: string;
  readonly availableForSale: boolean;
  // Decimal amount + ISO currency, exactly as Shopify returns it. Conversion to core Money goes
  // through ./money (the currency-exponent boundary) at the call site.
  readonly price: { readonly amount: string; readonly currencyCode: string };
};

// Shopify caps `nodes(ids:)` at 250 ids per call; batch to stay within that and avoid N+1.
const NODE_BATCH_SIZE = 250;

const PRICING_QUERY = `query CartPricing($ids: [ID!]!, $country: CountryCode!) {
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      availableForSale
      contextualPricing(context: { country: $country }) {
        price { amount currencyCode }
      }
    }
  }
}`;

type PricedNode = {
  readonly __typename: 'ProductVariant';
  readonly id: string;
  readonly availableForSale: boolean;
  readonly contextualPricing: {
    readonly price: { readonly amount: string; readonly currencyCode: string };
  };
};

type RawNode =
  | (Omit<PricedNode, 'contextualPricing'> & {
      readonly contextualPricing: PricedNode['contextualPricing'] | null;
    })
  | { readonly __typename: string };

type PricingResponse = {
  readonly nodes: readonly (RawNode | null)[];
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function isPricedVariant(node: RawNode | null): node is PricedNode {
  return (
    node !== null &&
    node.__typename === 'ProductVariant' &&
    'contextualPricing' in node &&
    node.contextualPricing !== null
  );
}

// Fetch presentment pricing + availability for the given variants in one market (by country).
// Unlike fetchGiftVariants this does NOT throw on unresolved ids: a cart can legitimately carry a
// variant that was deleted mid-session. Only variants that resolve to a live ProductVariant with a
// contextual price are returned; the caller decides how to treat the rest (an unpriceable non-gift
// line simply does not count toward the subtotal; an unresolved gift variant is treated as
// unavailable). Caller order is not guaranteed; look up by id.
export async function fetchVariantPricing(
  client: AdminGraphqlClient,
  variantIds: readonly string[],
  context: { readonly country: string },
): Promise<VariantPricing[]> {
  if (variantIds.length === 0) {
    return [];
  }

  const priced: VariantPricing[] = [];
  for (const batch of chunk(variantIds, NODE_BATCH_SIZE)) {
    const data = await client.request<PricingResponse>(PRICING_QUERY, {
      ids: batch,
      country: context.country,
    });
    for (const node of data.nodes) {
      if (isPricedVariant(node)) {
        priced.push({
          id: node.id,
          availableForSale: node.availableForSale,
          price: node.contextualPricing.price,
        });
      }
    }
  }
  return priced;
}
