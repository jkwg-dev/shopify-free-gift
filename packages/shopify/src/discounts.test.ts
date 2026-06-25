import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import {
  createScopedGiftDiscount,
  deactivateDiscount,
  type ScopedGiftDiscountInput,
} from './discounts.js';
import { ShopifyUserError } from './errors.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';

const baseInput: ScopedGiftDiscountInput = {
  code: 'GIFT-OPAQUE-7F3A',
  title: 'Campaign 12 / Gold / set abc123',
  giftVariantIds: ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
  minimumSubtotal: money(10000, 'USD'),
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: false },
};

const createOk = {
  body: {
    data: {
      discountCodeBasicCreate: {
        codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/99' },
        userErrors: [],
      },
    },
  },
};

type BasicCodeDiscountView = {
  readonly code: string;
  readonly combinesWith: unknown;
  readonly context: unknown;
  readonly minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: string } };
  readonly customerGets: {
    value: { percentage: number };
    items: { products: { productVariantsToAdd: string[] } };
  };
  readonly usageLimit?: unknown;
  readonly appliesOncePerCustomer?: unknown;
};

function getBasicCodeDiscount(body: ReturnType<typeof parseBody>): BasicCodeDiscountView {
  return body.variables.basicCodeDiscount as BasicCodeDiscountView;
}

describe('createScopedGiftDiscount — payload', () => {
  it('mints a 100%-off discount scoped to exactly the resolved variants', async () => {
    const { fetch, calls } = mockFetch([createOk]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBasicCodeDiscount(parseBody(calls[0]!));
    expect(input.customerGets.value.percentage).toBe(1);
    expect(input.customerGets.items.products.productVariantsToAdd).toEqual(
      baseInput.giftVariantIds,
    );
  });

  it('sets the minimum subtotal in the base currency as a decimal string', async () => {
    const { fetch, calls } = mockFetch([createOk]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBasicCodeDiscount(parseBody(calls[0]!));
    expect(input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe('100.00');
  });

  it('forwards combinesWith explicitly and makes the discount reusable (no single-use limits)', async () => {
    const { fetch, calls } = mockFetch([createOk]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await createScopedGiftDiscount(client, baseInput);

    const input = getBasicCodeDiscount(parseBody(calls[0]!));
    expect(input.combinesWith).toEqual(baseInput.combinesWith);
    expect(input.context).toEqual({ all: 'ALL' });
    expect('usageLimit' in input).toBe(false);
    expect('appliesOncePerCustomer' in input).toBe(false);
    expect(input.code).toBe(baseInput.code);
  });

  it('returns the opaque code and created discount id', async () => {
    const { fetch } = mockFetch([createOk]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(createScopedGiftDiscount(client, baseInput)).resolves.toEqual({
      code: 'GIFT-OPAQUE-7F3A',
      discountId: 'gid://shopify/DiscountCodeNode/99',
    });
  });

  it('throws ShopifyUserError when the mutation reports userErrors', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            discountCodeBasicCreate: {
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

describe('deactivateDiscount', () => {
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
