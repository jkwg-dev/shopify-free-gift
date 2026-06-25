// Typed errors for Admin API access. Callers can discriminate by class; nothing is swallowed.

export type GraphqlErrorDetail = {
  readonly message: string;
  readonly code?: string;
};

export type UserErrorDetail = {
  readonly message: string;
  readonly field?: readonly string[];
  readonly code?: string;
};

// Non-2xx HTTP response from the Admin API (auth failure, 5xx, etc.).
export class ShopifyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Shopify Admin API HTTP ${status}: ${body}`);
    this.name = 'ShopifyHttpError';
  }
}

// Top-level GraphQL `errors` that are not throttling.
export class ShopifyGraphqlError extends Error {
  constructor(readonly errors: readonly GraphqlErrorDetail[]) {
    super(`Shopify GraphQL error: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'ShopifyGraphqlError';
  }
}

// Cost-based throttling that survived all retries.
export class ShopifyThrottledError extends Error {
  constructor(readonly attempts: number) {
    super(`Shopify Admin API throttled after ${attempts} attempt(s)`);
    this.name = 'ShopifyThrottledError';
  }
}

// Mutation-level userErrors (validation failures returned with HTTP 200).
export class ShopifyUserError extends Error {
  constructor(readonly userErrors: readonly UserErrorDetail[]) {
    super(`Shopify mutation userErrors: ${userErrors.map((e) => e.message).join('; ')}`);
    this.name = 'ShopifyUserError';
  }
}

// A requested gift variant did not resolve to a live ProductVariant.
export class GiftVariantValidationError extends Error {
  constructor(readonly invalidIds: readonly string[]) {
    super(`Gift variant(s) not found or not a product variant: ${invalidIds.join(', ')}`);
    this.name = 'GiftVariantValidationError';
  }
}
