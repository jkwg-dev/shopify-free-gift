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

// Resolve a tier's gift configuration to the concrete set of gifts.
// - AND: the full gift-set, choice ignored.
// - OR: exactly the chosen option. An unknown or missing choice is REJECTED (thrown),
//   never silently defaulted, so we cannot mint a code for a gift the shopper did not pick.
export function resolveGiftSet(config: GiftConfig, choice: string | undefined): readonly Gift[] {
  if (config.kind === 'AND') {
    return config.gifts;
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
