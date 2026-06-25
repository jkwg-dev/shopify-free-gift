import type { Money } from '@free-gift-engine/core';
import type { AdminGraphqlClient } from './client.js';
import { ShopifyUserError, type UserErrorDetail } from './errors.js';
import { moneyToDecimalString } from './money.js';

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
  // Resolved gift variant GIDs — the exact variants discounted to $0.
  readonly giftVariantIds: readonly string[];
  // Minimum subtotal in the shop's BASE currency, so one code serves every market; Shopify
  // applies native market conversion at checkout.
  readonly minimumSubtotal: Money;
  // ISO 8601 activation instant. Supplied by the caller — this package keeps no clock.
  readonly startsAt: string;
  readonly combinesWith: DiscountCombinesWith;
};

export type CreatedDiscount = {
  readonly code: string;
  readonly discountId: string;
};

const CREATE_MUTATION = `mutation CreateScopedGiftDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
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
  readonly discountCodeBasicCreate: {
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

// Build the DiscountCodeBasicInput for a 100%-off, variant-scoped, reusable gift code.
// Reusable semantics: NO usageLimit (unlimited) and NO appliesOncePerCustomer — the same
// code is shared by every shopper in this (campaign, tier, gift-set). The discount only
// reduces the scoped variants when present and the minimum is met; it never adds the gift.
function buildBasicCodeDiscount(input: ScopedGiftDiscountInput): Record<string, unknown> {
  return {
    title: input.title,
    code: input.code,
    startsAt: input.startsAt,
    combinesWith: input.combinesWith,
    context: { all: 'ALL' },
    minimumRequirement: {
      subtotal: { greaterThanOrEqualToSubtotal: moneyToDecimalString(input.minimumSubtotal) },
    },
    customerGets: {
      value: { percentage: 1.0 },
      items: { products: { productVariantsToAdd: input.giftVariantIds } },
      appliesOnOneTimePurchase: true,
    },
  };
}

export async function createScopedGiftDiscount(
  client: AdminGraphqlClient,
  input: ScopedGiftDiscountInput,
): Promise<CreatedDiscount> {
  const data = await client.request<CreateResponse>(CREATE_MUTATION, {
    basicCodeDiscount: buildBasicCodeDiscount(input),
  });
  const result = data.discountCodeBasicCreate;
  throwOnUserErrors(result.userErrors);
  if (result.codeDiscountNode === null) {
    throw new ShopifyUserError([{ message: 'discountCodeBasicCreate returned no node' }]);
  }
  return { code: input.code, discountId: result.codeDiscountNode.id };
}

// Codes are immutable: superseding (deactivate + create new) is the only update path.
export async function deactivateDiscount(
  client: AdminGraphqlClient,
  discountId: string,
): Promise<void> {
  const data = await client.request<DeactivateResponse>(DEACTIVATE_MUTATION, { id: discountId });
  throwOnUserErrors(data.discountCodeDeactivate.userErrors);
}
