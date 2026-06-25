import { money } from '@free-gift-engine/core';
import {
  AdminGraphqlClient,
  ShopifyUserError,
  type FetchLike,
  type ScopedGiftDiscountInput,
} from '@free-gift-engine/shopify';
import { describe, expect, it } from 'vitest';
import { DuplicateDiscountCodeError } from '../ports.js';
import { ShopifyDiscountGatewayAdapter } from './shopifyDiscountGateway.js';

function clientReturning(body: unknown): AdminGraphqlClient {
  const fetch: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
    });
  return new AdminGraphqlClient({
    shopDomain: 's.myshopify.com',
    accessToken: 't',
    apiVersion: '2026-04',
    fetch,
  });
}

const input: ScopedGiftDiscountInput = {
  code: 'GIFT-OPAQUE-1',
  title: 'Summer / tier 1',
  giftVariantIds: ['gid://shopify/ProductVariant/G1'],
  minimumSubtotal: money(5000, 'USD'),
  startsAt: '2026-06-01T00:00:00.000Z',
  combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
};

function createBody(node: unknown, userErrors: unknown[]): unknown {
  return { data: { discountCodeBasicCreate: { codeDiscountNode: node, userErrors } } };
}

describe('ShopifyDiscountGatewayAdapter', () => {
  it('returns the created code + discount id on success', async () => {
    const gateway = new ShopifyDiscountGatewayAdapter(
      clientReturning(createBody({ id: 'gid://shopify/DiscountCodeNode/1' }, [])),
    );
    expect(await gateway.createScopedGiftDiscount(input)).toEqual({
      code: 'GIFT-OPAQUE-1',
      discountId: 'gid://shopify/DiscountCodeNode/1',
    });
  });

  it('maps a duplicate-code userError to DuplicateDiscountCodeError', async () => {
    const gateway = new ShopifyDiscountGatewayAdapter(
      clientReturning(
        createBody(null, [{ message: 'Discount code already exists', code: 'TAKEN' }]),
      ),
    );
    await expect(gateway.createScopedGiftDiscount(input)).rejects.toBeInstanceOf(
      DuplicateDiscountCodeError,
    );
  });

  it('rethrows non-duplicate userErrors as ShopifyUserError', async () => {
    const gateway = new ShopifyDiscountGatewayAdapter(
      clientReturning(createBody(null, [{ message: 'Minimum subtotal invalid', code: 'INVALID' }])),
    );
    await expect(gateway.createScopedGiftDiscount(input)).rejects.toBeInstanceOf(ShopifyUserError);
  });
});
