import type { Money } from '@free-gift-engine/core';
import type { AdminGraphqlClient } from './client.js';
import { collectionProductCount, giftProductsStillInCollection } from './collections.js';
import {
  EmptyQualifyingScopeError,
  GiftNotExcludedError,
  ShopifyUserError,
  type UserErrorDetail,
} from './errors.js';
import { moneyToDecimalString } from './money.js';
import { giftProductIdsForVariants } from './productTags.js';

// Which other discount classes this code is allowed to stack with. Required and explicit —
// this package does not pick a stacking policy; the campaign config decides (CLAUDE.md).
export type DiscountCombinesWith = {
  readonly productDiscounts: boolean;
  readonly orderDiscounts: boolean;
  readonly shippingDiscounts: boolean;
};

export type ScopedGiftDiscountInput = {
  // Opaque code string, supplied by the caller (derived from the minting key). This package
  // does not invent codes — that keeps it free of hidden randomness/state and idempotency
  // (the Postgres key->code mapping) lives outside, per dependency inversion (CLAUDE.md).
  readonly code: string;
  // Merchant-facing label shown in the Shopify admin discounts list.
  readonly title: string;
  // Resolved gift variant GIDs — the exact variants the shopper gets free (customerGets).
  readonly giftVariantIds: readonly string[];
  // Qualifying-spend threshold in the shop's BASE currency (Shopify converts per market at
  // checkout). Used as the BXGY customerBuys minimum purchase amount.
  readonly minimumSubtotal: Money;
  // GID of the shared qualifying smart collection (everything NOT tagged app:fge_gift). Used as the
  // BXGY customerBuys scope so the THRESHOLD is measured against qualifying items, never the gift.
  readonly qualifyingCollectionId: string;
  // ISO 8601 activation instant. Supplied by the caller — this package keeps no clock.
  readonly startsAt: string;
  // ISO 8601 expiry instant (= the campaign's endsAt). When set, Shopify stops honoring the code at
  // the window close, so an expired campaign's held codes can't be redeemed — schedule expiry needs
  // no cron (the lazy /validate gate stops offering and Shopify stops honoring at the same instant).
  readonly endsAt?: string;
  readonly combinesWith: DiscountCombinesWith;
  // Model-C flip (default false = today's behavior): when true, gift products are INTENTIONALLY
  // members of the qualifying collection (BXGY's buys/gets split keeps the $0 gift from
  // self-qualifying), so the "gifts must be excluded" mint guard is skipped. The empty-scope guard
  // still applies. Set by the composition root from the FGE_GIFTS_INCLUDED flag.
  readonly giftsIncluded?: boolean;
};

export type CreatedDiscount = {
  readonly code: string;
  readonly discountId: string;
};

// BXGY ("Buy X Get Y"), not "amount off products": an amount-off-products discount measures its
// minimum against the DISCOUNTED (gift) items, so an expensive gift self-qualifies and a cheap gift
// can never qualify. BXGY separates customerBuys (qualifying spend on the qualifying collection,
// excluding gifts) from customerGets (the free gift), giving a real server-side backstop — drop
// below the threshold and Shopify releases the gift. (Confirmed via live spike.)
const CREATE_MUTATION = `mutation CreateScopedGiftDiscount($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
  discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

const DEACTIVATE_MUTATION = `mutation DeactivateDiscount($id: ID!) {
  discountCodeDeactivate(id: $id) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

type CreateResponse = {
  readonly discountCodeBxgyCreate: {
    readonly codeDiscountNode: { readonly id: string } | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
};

type DeactivateResponse = {
  readonly discountCodeDeactivate: {
    readonly codeDiscountNode: { readonly id: string } | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
};

function throwOnUserErrors(userErrors: readonly UserErrorDetail[]): void {
  if (userErrors.length > 0) {
    throw new ShopifyUserError(userErrors);
  }
}

// Build the DiscountCodeBxgyInput for a reusable "spend X, get the gift(s) free" code.
// - customerBuys: minimum purchase AMOUNT (base currency) on the qualifying collection (gifts
//   excluded by the app:fge_gift tag), so the gift can't self-qualify.
// - customerGets: the gift variant(s) at 100% off via discountOnQuantity (BXGY rejects top-level
//   percentage); quantity = number of gift variants (one unit of each, e.g. an AND set).
// Reusable semantics: NO usageLimit, NO appliesOncePerCustomer — one code per (campaign,tier,set).
// NOTE (spike): when customerBuys is a narrow product scope, Shopify requires the amount >= the
// cheapest prerequisite item; the SHARED store-wide qualifying collection contains sub-threshold
// items so any tier threshold is valid. If it isn't, Shopify returns a userError (surfaced below).
function buildBxgyCodeDiscount(input: ScopedGiftDiscountInput): Record<string, unknown> {
  return {
    title: input.title,
    code: input.code,
    startsAt: input.startsAt,
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    combinesWith: input.combinesWith,
    context: { all: 'ALL' },
    customerBuys: {
      value: { amount: moneyToDecimalString(input.minimumSubtotal) },
      items: { collections: { add: [input.qualifyingCollectionId] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(input.giftVariantIds.length),
          effect: { percentage: 1.0 },
        },
      },
      items: { products: { productVariantsToAdd: input.giftVariantIds } },
    },
  };
}

export async function createScopedGiftDiscount(
  client: AdminGraphqlClient,
  input: ScopedGiftDiscountInput,
): Promise<CreatedDiscount> {
  if (input.giftVariantIds.length === 0) {
    throw new ShopifyUserError([
      { message: 'createScopedGiftDiscount requires at least one gift variant' },
    ]);
  }
  // Precondition: the customerBuys scope must be a REAL, NON-EMPTY collection. A missing collection
  // (provisioning silently failed) or an empty one makes the threshold void, so the BXGY gift would
  // always be free ($0 leak). Refuse to mint — do NOT call discountCodeBxgyCreate.
  const qualifyingCount = await collectionProductCount(client, input.qualifyingCollectionId);
  if (qualifyingCount === null) {
    throw new EmptyQualifyingScopeError(input.qualifyingCollectionId, 'missing');
  }
  if (qualifyingCount === 0) {
    throw new EmptyQualifyingScopeError(input.qualifyingCollectionId, 'empty');
  }
  // Precondition (EXCLUSION model only): the gift products MUST be excluded from the qualifying scope,
  // else the gift counts toward its own spend (self-qualify leak). Membership is authoritative — an
  // untagged gift product necessarily matches the NOT_EQUALS rule, so it shows as a member. Refuse to
  // mint if any remain. SKIPPED under the inclusion model (giftsIncluded): there gifts are MEANT to be
  // members and Shopify's buys/gets split prevents self-qualification (validated). The empty-scope
  // guard above still applies in both models.
  if (input.giftsIncluded !== true) {
    const giftProductIds = await giftProductIdsForVariants(client, input.giftVariantIds);
    const stillMembers = await giftProductsStillInCollection(
      client,
      input.qualifyingCollectionId,
      giftProductIds,
    );
    if (stillMembers.length > 0) {
      throw new GiftNotExcludedError(input.qualifyingCollectionId, stillMembers);
    }
  }
  const data = await client.request<CreateResponse>(CREATE_MUTATION, {
    bxgyCodeDiscount: buildBxgyCodeDiscount(input),
  });
  const result = data.discountCodeBxgyCreate;
  throwOnUserErrors(result.userErrors);
  if (result.codeDiscountNode === null) {
    throw new ShopifyUserError([{ message: 'discountCodeBxgyCreate returned no node' }]);
  }
  return { code: input.code, discountId: result.codeDiscountNode.id };
}

// Codes are immutable: superseding (deactivate + create new) is the only update path.
// discountCodeDeactivate operates on any DiscountCodeNode, so it handles BXGY and basic codes alike.
export async function deactivateDiscount(
  client: AdminGraphqlClient,
  discountId: string,
): Promise<void> {
  const data = await client.request<DeactivateResponse>(DEACTIVATE_MUTATION, { id: discountId });
  throwOnUserErrors(data.discountCodeDeactivate.userErrors);
}
