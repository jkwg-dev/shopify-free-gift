import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import {
  createScopedGiftDiscount,
  deactivateDiscount,
  type ScopedGiftDiscountInput,
} from './discounts.js';
import { AdminGraphqlClient } from './client.js';
import { EmptyQualifyingScopeError, GiftNotExcludedError, ShopifyUserError } from './errors.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const COLLECTION = 'gid://shopify/Collection/777';
const GIFT_PRODUCT = 'gid://shopify/Product/100';

// Mint preconditions run BEFORE discountCodeBxgyCreate, in this order:
//   1. count        — qualifying collection exists + non-empty
//   2. nodes        — resolve gift variants -> owning products
//   3. hasProduct   — each gift product is EXCLUDED from the qualifying collection
// so a successful create is the four-call sequence [count, nodes, hasProduct, create].
const countOk = (count: number) => ({
  body: { data: { collection: { id: COLLECTION, productsCount: { count } } } },
});
const countMissing = { body: { data: { collection: null } } };
// Both gift variants resolve to ONE product (deduped) -> a single hasProduct check.
const nodesOk = {
  body: {
    data: {
      nodes: [
        {
          __typename: 'ProductVariant',
          id: 'gid://shopify/ProductVariant/1',
          product: { id: GIFT_PRODUCT },
        },
        {
          __typename: 'ProductVariant',
          id: 'gid://shopify/ProductVariant/2',
          product: { id: GIFT_PRODUCT },
        },
      ],
    },
  },
};
const giftExcluded = { body: { data: { collection: { hasProduct: false } } } };
const giftStillMember = { body: { data: { collection: { hasProduct: true } } } };

const baseInput: ScopedGiftDiscountInput = {
  code: 'GIFT-OPAQUE-7F3A',
  title: 'Campaign 12 / Gold / set abc123',
  giftVariantIds: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
  minimumSubtotal: money(10000, 'USD'),
  qualifyingCollectionId: COLLECTION,
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true },
};

const createOk = {
  body: {
    data: {
      discountCodeBxgyCreate: {
        codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/99' },
        userErrors: [],
      },
    },
  },
};

// Full happy-path precondition reads followed by the create mutation (calls[3] is the create).
const mintOk = [countOk(5), nodesOk, giftExcluded, createOk];

type BxgyView = {
  readonly code: string;
  readonly combinesWith: unknown;
  readonly context: unknown;
  readonly customerBuys: {
    value: { amount: string };
    items: { collections: { add: string[] } };
  };
  readonly customerGets: {
    value: { discountOnQuantity: { quantity: string; effect: { percentage: number } } };
    items: { products: { productVariantsToAdd: string[] } };
  };
  readonly usageLimit?: unknown;
  readonly appliesOncePerCustomer?: unknown;
};

function getBxgy(body: ReturnType<typeof parseBody>): BxgyView {
  return body.variables.bxgyCodeDiscount as BxgyView;
}

describe('createScopedGiftDiscount — BXGY payload', () => {
  it('measures the threshold on the qualifying collection (customerBuys), NOT the gift', async () => {
    const { fetch, calls } = mockFetch(mintOk);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBxgy(parseBody(calls[3]!));
    expect(input.customerBuys.value.amount).toBe('100.00'); // base-currency threshold
    expect(input.customerBuys.items.collections.add).toEqual([COLLECTION]);
  });

  it('gives the resolved gift variant(s) free via discountOnQuantity (one unit each)', async () => {
    const { fetch, calls } = mockFetch(mintOk);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBxgy(parseBody(calls[3]!));
    expect(input.customerGets.items.products.productVariantsToAdd).toEqual(
      baseInput.giftVariantIds,
    );
    expect(input.customerGets.value.discountOnQuantity.quantity).toBe('2'); // 2 gift variants
    expect(input.customerGets.value.discountOnQuantity.effect.percentage).toBe(1);
  });

  it('forwards combinesWith explicitly and stays reusable (no single-use limits)', async () => {
    const { fetch, calls } = mockFetch(mintOk);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBxgy(parseBody(calls[3]!));
    expect(input.combinesWith).toEqual(baseInput.combinesWith);
    expect(input.context).toEqual({ all: 'ALL' });
    expect('usageLimit' in input).toBe(false);
    expect('appliesOncePerCustomer' in input).toBe(false);
    expect(input.code).toBe(baseInput.code);
  });

  it('returns the opaque code and created discount id', async () => {
    const { fetch } = mockFetch(mintOk);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(createScopedGiftDiscount(client, baseInput)).resolves.toEqual({
      code: 'GIFT-OPAQUE-7F3A',
      discountId: 'gid://shopify/DiscountCodeNode/99',
    });
  });

  it('rejects an empty gift set before calling Shopify', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(
      createScopedGiftDiscount(client, { ...baseInput, giftVariantIds: [] }),
    ).rejects.toBeInstanceOf(ShopifyUserError);
    expect(calls).toHaveLength(0);
  });

  it('REFUSES to mint when the qualifying collection is missing (no create call)', async () => {
    const { fetch, calls } = mockFetch([countMissing]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(createScopedGiftDiscount(client, baseInput)).rejects.toBeInstanceOf(
      EmptyQualifyingScopeError,
    );
    // Only the count query ran — discountCodeBxgyCreate was NOT called against a missing scope.
    expect(calls).toHaveLength(1);
    expect(parseBody(calls[0]!).query).not.toContain('discountCodeBxgyCreate');
  });

  it('REFUSES to mint when the qualifying collection is empty (no create call)', async () => {
    const { fetch, calls } = mockFetch([countOk(0)]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(createScopedGiftDiscount(client, baseInput)).rejects.toBeInstanceOf(
      EmptyQualifyingScopeError,
    );
    expect(calls).toHaveLength(1);
    expect(parseBody(calls[0]!).query).not.toContain('discountCodeBxgyCreate');
  });

  it('REFUSES to mint when a gift product is still in the qualifying collection (no create call)', async () => {
    // count OK + non-empty, gift resolves to a product, but that product is STILL a member
    // (untagged / not excluded) — minting would let the gift self-qualify, so abort.
    const { fetch, calls } = mockFetch([countOk(5), nodesOk, giftStillMember]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(createScopedGiftDiscount(client, baseInput)).rejects.toBeInstanceOf(
      GiftNotExcludedError,
    );
    // count + nodes + hasProduct ran; discountCodeBxgyCreate did NOT.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(parseBody(call).query).not.toContain('discountCodeBxgyCreate');
    }
  });

  it('throws ShopifyUserError when the mutation reports userErrors', async () => {
    const { fetch } = mockFetch([
      countOk(5),
      nodesOk,
      giftExcluded,
      {
        body: {
          data: {
            discountCodeBxgyCreate: {
              codeDiscountNode: null,
              userErrors: [{ field: ['code'], message: 'Code already exists', code: 'TAKEN' }],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(createScopedGiftDiscount(client, baseInput)).rejects.toBeInstanceOf(
      ShopifyUserError,
    );
  });
});

describe('deactivateDiscount (type-agnostic — handles BXGY and basic)', () => {
  it('deactivates by id', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/99' },
              userErrors: [],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await deactivateDiscount(client, 'gid://shopify/DiscountCodeNode/99');

    expect(parseBody(calls[0]!).variables).toEqual({ id: 'gid://shopify/DiscountCodeNode/99' });
  });

  it('throws ShopifyUserError on a deactivation userError', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: null,
              userErrors: [{ message: 'Not found' }],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(
      deactivateDiscount(client, 'gid://shopify/DiscountCodeNode/1'),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });
});
