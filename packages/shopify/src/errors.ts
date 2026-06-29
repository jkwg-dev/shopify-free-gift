// Typed errors for Admin API access. Callers can discriminate by class; nothing is swallowed.

export type GraphqlErrorDetail = {
  readonly message: string;
  readonly code?: string;
  // Field-level errors carry the response path of the failing node (e.g. ['nodes', 2, 'product',
  // 'publishedOnPublication']). Kept so a partial-tolerant caller can log WHICH node failed.
  readonly path?: readonly (string | number)[];
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

// One or more gift products are STILL members of the qualifying collection (not tagged/excluded), so
// the gift would count toward its own qualifying spend (self-qualify leak). Thrown BEFORE minting —
// gift products MUST be excluded (provisioned/tagged) first.
export class GiftNotExcludedError extends Error {
  constructor(
    readonly collectionId: string,
    readonly productIds: readonly string[],
  ) {
    super(
      `Gift product(s) ${productIds.join(', ')} are still members of qualifying collection ` +
        `${collectionId} — not tagged app:fge_gift / not yet excluded. Refusing to mint a BXGY code ` +
        `(the gift would self-qualify). Provision (tag + wait for exclusion) before minting.`,
    );
    this.name = 'GiftNotExcludedError';
  }
}

// The BXGY customerBuys scope (qualifying collection) is missing or empty, so the threshold would be
// void and the gift would always be free ($0 leak). Thrown BEFORE minting — never create a code
// against an empty/missing scope.
export class EmptyQualifyingScopeError extends Error {
  constructor(
    readonly collectionId: string,
    readonly reason: 'missing' | 'empty',
  ) {
    super(
      reason === 'missing'
        ? `Qualifying collection ${collectionId} does not exist — cannot mint a BXGY gift code ` +
            `(check write_products provisioning / collection creation)`
        : `Qualifying collection ${collectionId} is empty — cannot mint a BXGY gift code ` +
            `(no qualifying products; threshold would be void and the gift always free)`,
    );
    this.name = 'EmptyQualifyingScopeError';
  }
}
