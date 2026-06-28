import {
  createScopedGiftDiscount,
  deactivateDiscount,
  deleteDiscount,
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
  // `giftsIncluded` is the model-C flag, captured at the composition root. It rides on every mint so
  // the shopify wrapper skips the "gifts must be excluded" guard under the inclusion model. Default
  // false = today's exclusion behavior (inert when the flag is OFF).
  constructor(
    private readonly client: AdminGraphqlClient,
    private readonly giftsIncluded = false,
  ) {}

  async createScopedGiftDiscount(input: ScopedGiftDiscountInput): Promise<CreatedDiscount> {
    try {
      return await createScopedGiftDiscount(this.client, {
        ...input,
        giftsIncluded: input.giftsIncluded ?? this.giftsIncluded,
      });
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

  deleteDiscount(discountId: string): Promise<void> {
    return deleteDiscount(this.client, discountId);
  }
}
