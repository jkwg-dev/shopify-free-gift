// A concrete gift variant that becomes free (100% off) once the discount applies.
export type Gift = {
  readonly variantId: string;
};

// One selectable branch of an OR tier ("Choose your free gift: A or B").
export type GiftOption = {
  readonly id: string;
  readonly variantId: string;
};

// A tier's gift configuration. AND gives every gift in the set; OR gives exactly one of the
// options, chosen by the shopper. Discriminated union so an OR tier without options or an
// AND tier with a `choice` is unrepresentable.
export type GiftConfig =
  | { readonly kind: 'AND'; readonly gifts: readonly Gift[] }
  | { readonly kind: 'OR'; readonly options: readonly GiftOption[] };

export class InvalidGiftChoiceError extends Error {
  constructor(
    readonly choice: string | undefined,
    readonly available: readonly string[],
  ) {
    super(
      `Invalid gift choice ${choice === undefined ? '(none)' : `"${choice}"`}; ` +
        `expected one of: ${available.join(', ')}`,
    );
    this.name = 'InvalidGiftChoiceError';
  }
}

// Per-product variant selection for AND tiers (keyed by productId → chosen variantId).
export type AndChoices = Readonly<Record<string, string>>;

// Resolve a tier's gift configuration to the concrete set of gifts.
// - AND: one variant per product. `andChoices` maps productId → chosen variantId; a gift whose
//   variantId matches is included. When no andChoices are provided (empty/undefined), all gifts
//   are returned (backward compat for callers that don't support per-product selection yet).
// - OR: exactly the chosen option. An unknown or missing choice is REJECTED (thrown),
//   never silently defaulted, so we cannot mint a code for a gift the shopper did not pick.
export function resolveGiftSet(
  config: GiftConfig,
  choice: string | undefined,
  andChoices?: AndChoices,
): readonly Gift[] {
  if (config.kind === 'AND') {
    const chosen = andChoices !== undefined ? Object.values(andChoices) : [];
    if (chosen.length === 0) return config.gifts;
    const chosenSet = new Set(chosen);
    const filtered = config.gifts.filter((g) => chosenSet.has(g.variantId));
    return filtered.length > 0 ? filtered : config.gifts;
  }
  const option = config.options.find((o) => o.id === choice);
  if (option === undefined) {
    throw new InvalidGiftChoiceError(
      choice,
      config.options.map((o) => o.id),
    );
  }
  return [{ variantId: option.variantId }];
}
