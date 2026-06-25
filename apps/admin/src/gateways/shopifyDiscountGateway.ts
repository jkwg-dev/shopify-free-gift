import {
  createScopedGiftDiscount,
  deactivateDiscount,
  ShopifyUserError,
  type AdminGraphqlClient,
  type CreatedDiscount,
  type ScopedGiftDiscountInput,
} from '@free-gift-engine/shopify';
import { DuplicateDiscountCodeError, type ShopifyDiscountGateway } from '../ports.js';

// Composition-layer adapter implementing the ShopifyDiscountGateway port over the typed Admin API
// wrappers. Its one job beyond delegation: translate Shopify's "code already exists" userError into
// the port's DuplicateDiscountCodeError so the mapping store can regenerate. Codes are opaque/random
// so a collision is astronomically rare; this is a defensive fallback. (If a real collision ever
// surfaces, confirm the exact 2026-04 userError code and tighten the match.)
function isDuplicateCode(error: ShopifyUserError): boolean {
  return error.userErrors.some((e) => {
    const code = e.code?.toUpperCase();
    if (code === 'TAKEN' || code === 'DUPLICATE' || code === 'DISCOUNT_CODE_TAKEN') {
      return true;
    }
    return /already exists|already in use|taken/i.test(e.message);
  });
}

export class ShopifyDiscountGatewayAdapter implements ShopifyDiscountGateway {
  constructor(private readonly client: AdminGraphqlClient) {}

  async createScopedGiftDiscount(input: ScopedGiftDiscountInput): Promise<CreatedDiscount> {
    try {
      return await createScopedGiftDiscount(this.client, input);
    } catch (error) {
      if (error instanceof ShopifyUserError && isDuplicateCode(error)) {
        throw new DuplicateDiscountCodeError(input.code);
      }
      throw error;
    }
  }

  deactivateDiscount(discountId: string): Promise<void> {
    return deactivateDiscount(this.client, discountId);
  }
}
