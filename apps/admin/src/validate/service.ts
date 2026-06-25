// Server-authoritative resolution for /validate. Composes core.resolveActiveGifts (the money
// logic), authoritative presentment pricing (the "cart source"), and the 3a gift-code mapping
// store (get-or-create the reusable scoped code). NOTHING here trusts the client beyond the cart
// shape, OR choice, and decline flag — prices, gift status, currency, and tier are all recomputed.
//
// Defense-in-depth, not the sole gate: the returned code only discounts its scoped variant(s), and
// only when the REAL cart meets the discount's base-currency minimum at checkout (Shopify converts
// per market). So even a fooled /validate cannot leak revenue — it exists to return the correct
// gift for the real cart and to avoid handing out misleading codes. Suppression is protected the
// same way: a higher-tier code carries a higher minimum.
import {
  money,
  resolveActiveGifts,
  resolvedGiftSetHash,
  type CartLine,
  type Campaign as CoreCampaign,
  type Gift,
  type Money,
  type Tier as CoreTier,
} from '@free-gift-engine/core';
import {
  decimalToMinorUnits,
  type DiscountCombinesWith,
  type VariantPricing,
} from '@free-gift-engine/shopify';
import type { Campaign, Tier } from '../domain.js';
import type { GiftCodeMappingStore } from '../store/giftCodeMapping.js';
import type { ValidateRequest, ValidateResult } from './contract.js';

// The single active campaign for a shop plus the shop's base currency (the currency the discount's
// minimum-subtotal is set in). Resolved at the composition root from the shop + campaign records.
export type ActiveCampaignContext = {
  readonly shopId: string;
  readonly baseCurrency: string;
  readonly campaign: Campaign;
};

export type ValidateServiceDeps = {
  // Resolves the active campaign for a verified shop domain, or null if none is live.
  readonly resolveActiveCampaign: (shopDomain: string) => Promise<ActiveCampaignContext | null>;
  // Authoritative presentment pricing + availability for the given variants in the buyer's country.
  readonly priceVariants: (
    variantIds: readonly string[],
    context: { readonly country: string },
  ) => Promise<readonly VariantPricing[]>;
  // Concurrency-safe get-or-create for the reusable scoped gift code.
  readonly mappingStore: GiftCodeMappingStore;
  readonly now: () => Date;
  // Stacking policy for minted gift codes. Defaults to fully non-combinable: suppression relies on
  // a higher-tier code carrying a higher minimum, which stacking would defeat.
  readonly giftCombinesWith?: DiscountCombinesWith;
};

// Thrown for client-supplied data that fails server validation (mapped to 400 by the handler).
export class ValidateBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidateBadRequestError';
  }
}

const NON_COMBINABLE: DiscountCombinesWith = {
  productDiscounts: false,
  orderDiscounts: false,
  shippingDiscounts: false,
};

function giftSetVariantIds(campaign: Campaign): Set<string> {
  const ids = new Set<string>();
  for (const tier of campaign.tiers) {
    if (tier.gift.kind === 'AND') {
      for (const g of tier.gift.gifts) ids.add(g.variantId);
    } else {
      for (const o of tier.gift.options) ids.add(o.variantId);
    }
  }
  return ids;
}

// The threshold actually enforced for a tier in this market: the base-currency threshold when the
// buyer is in the base currency, otherwise the market's pre-resolved presentment threshold. Returns
// null when a non-base market has no configured threshold for this tier (campaign not sold there).
function presentmentThreshold(
  tier: Tier,
  presentmentCurrency: string,
  baseCurrency: string,
): Money | null {
  if (presentmentCurrency === baseCurrency) {
    return tier.baseThreshold;
  }
  const match = tier.marketThresholds.find((m) => m.presentmentCurrency === presentmentCurrency);
  return match?.resolvedThreshold ?? null;
}

export async function resolveValidate(
  shopDomain: string,
  request: ValidateRequest,
  deps: ValidateServiceDeps,
): Promise<ValidateResult> {
  const context = await deps.resolveActiveCampaign(shopDomain);
  if (context === null) {
    return { status: 'no-gift', reason: 'inactive' };
  }
  const { campaign, baseCurrency } = context;
  const presentment = request.presentmentCurrency;

  // Resolve every tier's threshold in the presentment currency up front. If a non-base market is
  // missing any threshold, the campaign is not offered there — treat as inactive (all-or-nothing,
  // never a partial offer).
  const thresholdByTier = new Map<string, Money>();
  for (const tier of campaign.tiers) {
    const threshold = presentmentThreshold(tier, presentment, baseCurrency);
    if (threshold === null) {
      return { status: 'no-gift', reason: 'inactive' };
    }
    thresholdByTier.set(tier.id, threshold);
  }

  const giftVariantSet = giftSetVariantIds(campaign);

  // One authoritative pricing call over cart variants ∪ all candidate gift variants (the latter so
  // we can gate on gift availability even when the gift line is not yet in the cart).
  const variantIds = [...new Set([...request.cart.map((l) => l.variantId), ...giftVariantSet])];
  const pricingList = await deps.priceVariants(variantIds, { country: request.countryCode });
  const pricingById = new Map<string, VariantPricing>(pricingList.map((p) => [p.id, p]));

  // Validate the claimed presentment currency against the authoritative (country-derived) prices.
  const mismatched = pricingList.find((p) => p.price.currencyCode !== presentment);
  if (mismatched !== undefined) {
    throw new ValidateBadRequestError(
      `Presentment currency ${presentment} does not match priced currency ${mismatched.price.currencyCode} for country ${request.countryCode}`,
    );
  }

  // Build core cart lines with server-derived isGift and authoritative prices. A line is a gift
  // (excluded from the subtotal) only if it claims app-added AND its variant is a campaign gift.
  // Unpriceable non-gift lines (e.g. a variant deleted mid-session) simply do not count.
  const coreCart: CartLine[] = [];
  for (const line of request.cart) {
    const isGift = line.appAdded && giftVariantSet.has(line.variantId);
    if (isGift) {
      coreCart.push({
        variantId: line.variantId,
        unitPrice: money(0, presentment),
        quantity: line.quantity,
        isGift: true,
      });
      continue;
    }
    const priced = pricingById.get(line.variantId);
    if (priced === undefined) {
      continue;
    }
    coreCart.push({
      variantId: line.variantId,
      unitPrice: money(decimalToMinorUnits(priced.price.amount, presentment), presentment),
      quantity: line.quantity,
      isGift: false,
    });
  }

  const coreTiers: CoreTier[] = campaign.tiers.map((tier) => ({
    id: tier.id,
    threshold: thresholdByTier.get(tier.id) as Money,
    gift: tier.gift,
  }));
  const coreCampaign: CoreCampaign = {
    currency: presentment,
    schedule: { startsAt: campaign.startsAt, endsAt: campaign.endsAt },
    suppression: campaign.suppression,
    tiers: coreTiers,
  };

  // resolveGiftSet throws InvalidGiftChoiceError on an unknown/missing OR choice — let it propagate
  // to the handler, which maps it to a 400 (never silently default a gift).
  const resolved = resolveActiveGifts({
    campaign: coreCampaign,
    cart: coreCart,
    now: deps.now(),
    choices: request.choices,
    declined: request.declined,
  });

  if (resolved.status === 'inactive') {
    return { status: 'no-gift', reason: 'inactive' };
  }
  if (resolved.status === 'no-gift') {
    return { status: 'no-gift', reason: resolved.reason };
  }

  // Cumulative is unsupported on Advanced: multiple non-combinable codes cannot all redeem on one
  // cart, and a single union code cannot enforce per-tier minimums (CLAUDE.md). The admin must not
  // create cumulative campaigns; if one slips through and resolves more than one tier, refuse here
  // rather than hand out codes that cannot all apply.
  if (resolved.resolved.length > 1) {
    return { status: 'no-gift', reason: 'cumulative-unsupported' };
  }

  const winning = resolved.resolved[0];
  if (winning === undefined) {
    return { status: 'no-gift', reason: 'below-threshold' };
  }

  // Never promise an out-of-stock (or unresolved) gift variant.
  const giftVariantIds = winning.gifts.map((g: Gift) => g.variantId);
  for (const variantId of giftVariantIds) {
    const priced = pricingById.get(variantId);
    if (priced === undefined || !priced.availableForSale) {
      return { status: 'no-gift', reason: 'gift-unavailable' };
    }
  }

  const domainTier = campaign.tiers.find((t) => t.id === winning.tierId) as Tier;
  const mapping = await deps.mappingStore.getOrCreate(
    {
      campaignId: campaign.id,
      tierId: winning.tierId,
      resolvedGiftSetHash: resolvedGiftSetHash(winning.gifts),
      configVersionHash: campaign.configVersionHash,
    },
    {
      title: `${campaign.name} — tier ${domainTier.position}`,
      giftVariantIds,
      minimumSubtotal: domainTier.baseThreshold,
      startsAt: campaign.startsAt.toISOString(),
      combinesWith: deps.giftCombinesWith ?? NON_COMBINABLE,
    },
  );
  if (mapping.code === null) {
    throw new Error(`Gift-code mapping for tier ${winning.tierId} resolved without a code`);
  }

  return {
    status: 'gift',
    currency: presentment,
    subtotal: resolved.subtotal,
    tierId: winning.tierId,
    giftVariantIds,
    code: mapping.code,
    appliedThreshold: thresholdByTier.get(winning.tierId) as Money,
  };
}
