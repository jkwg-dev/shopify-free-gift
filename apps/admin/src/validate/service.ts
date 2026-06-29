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
  giftOfferability,
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
  convertBaseToPresentmentCeil,
  decimalToMinorUnits,
  type DiscountCombinesWith,
  type GiftChannelAvailability,
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
  // Online-Store publish status + stock for the winning gift variants — the gift-unavailable backstop
  // gates on publication (not just stock), so an unpublished-but-in-stock gift is never promised.
  readonly fetchChannelAvailability: (
    variantIds: readonly string[],
  ) => Promise<ReadonlyMap<string, GiftChannelAvailability>>;
  // Concurrency-safe get-or-create for the reusable scoped gift code.
  readonly mappingStore: GiftCodeMappingStore;
  // GID of the shared qualifying smart collection (BXGY customerBuys scope). Provisioned at campaign
  // activation (tag gifts → ensure collection → wait for exclusion) before any code is minted.
  readonly qualifyingCollectionId: string;
  readonly now: () => Date;
  // Stacking policy for minted gift codes. Defaults to GIFT_COMBINES_WITH (productDiscounts:true so
  // FGE coexists with other BXGY discounts on different line items).
  readonly giftCombinesWith?: DiscountCombinesWith;
};

// Thrown for client-supplied data that fails server validation (mapped to 400 by the handler).
export class ValidateBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidateBadRequestError';
  }
}

// Gift codes allow product-discount combination so FGE coexists with other BXGY discounts (e.g.
// Kite BOGO) on different line items — both sides must set productDiscounts:true for Shopify to
// let them coexist. On Advanced, two product discounts cannot STACK on the same line (Plus-only);
// they coexist on different products. Suppression (highest-tier-only) is enforced server-side by
// /validate handing out a single code; a lower-tier code discovered manually would not stack with
// the highest-tier code on the same gift line.
export const GIFT_COMBINES_WITH: DiscountCombinesWith = {
  productDiscounts: true,
  orderDiscounts: true,
  shippingDiscounts: true,
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

// Parse the client-claimed FX rate string to a usable factor, or null when absent/invalid. Shared by
// the handler (to 400 a present-but-invalid value) and the services (to derive). A non-positive or
// non-finite rate is rejected (null).
export function parsePresentmentRate(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

// The threshold actually enforced for a tier in this market. In the BASE currency it is the
// base-currency threshold (rate ignored). Otherwise it is DERIVED from Shopify's own market rate —
// ceil(baseThreshold x rate) — the SAME rate Shopify uses to convert the BXGY minimum at checkout, so
// the displayed/compared threshold equals the enforced floor. Stored manual marketThresholds rows are
// intentionally IGNORED (single source of truth = Shopify's rate). Returns null when a non-base market
// has no valid rate — the campaign is simply not offered there (never priced against an unknown floor).
export function presentmentThreshold(
  tier: Tier,
  presentmentCurrency: string,
  baseCurrency: string,
  rate: number | null,
): Money | null {
  if (presentmentCurrency === baseCurrency) {
    return tier.baseThreshold;
  }
  if (rate === null) {
    return null;
  }
  return convertBaseToPresentmentCeil(tier.baseThreshold, presentmentCurrency, rate);
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
  const rate = parsePresentmentRate(request.presentmentRate);

  // Resolve every tier's threshold in the presentment currency up front. In a non-base market without
  // a valid Shopify rate the campaign is not offered there — treat as inactive (all-or-nothing, never
  // a partial offer).
  const thresholdByTier = new Map<string, Money>();
  for (const tier of campaign.tiers) {
    const threshold = presentmentThreshold(tier, presentment, baseCurrency, rate);
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
    return { status: 'no-gift', reason: resolved.reason, subtotal: resolved.subtotal };
  }

  // Cumulative is unsupported on Advanced: multiple non-combinable codes cannot all redeem on one
  // cart, and a single union code cannot enforce per-tier minimums (CLAUDE.md). The admin must not
  // create cumulative campaigns; if one slips through and resolves more than one tier, refuse here
  // rather than hand out codes that cannot all apply.
  if (resolved.resolved.length > 1) {
    return { status: 'no-gift', reason: 'cumulative-unsupported', subtotal: resolved.subtotal };
  }

  const winning = resolved.resolved[0];
  if (winning === undefined) {
    return { status: 'no-gift', reason: 'below-threshold', subtotal: resolved.subtotal };
  }

  // Never promise an unavailable gift. The SAME predicate the storefront chooser uses (published to the
  // Online Store AND priced AND in stock). For an AND tier this loops EVERY required gift, so the tier
  // is all-or-nothing: any one unavailable required gift -> the whole tier yields no gift (one BXGY code
  // grants the AND set together; it cannot partially grant). Channel reads only the winning gifts.
  const giftVariantIds = winning.gifts.map((g: Gift) => g.variantId);
  // The availability lookup is a Shopify call on the checkout-click path; it MUST NOT 500 the widget
  // (same fail-safe as the mint below). FAIL CLOSED: if we cannot confirm the winning gift is published
  // + in stock (e.g. publishedOnPublication errors under the read_products token for an unpublished
  // product), do not promise it — degrade to gift-unavailable so the widget greys it, never throws.
  let channel: ReadonlyMap<string, GiftChannelAvailability>;
  try {
    channel = await deps.fetchChannelAvailability(giftVariantIds);
  } catch (err) {
    console.error('[validate] gift channel-availability lookup failed; degrading to no-gift', err);
    return { status: 'no-gift', reason: 'gift-unavailable', subtotal: resolved.subtotal };
  }
  for (const variantId of giftVariantIds) {
    const priced = pricingById.has(variantId);
    const ch = channel.get(variantId);
    const offerable = giftOfferability({
      resolved: priced, // a gift not in the authoritative pricing is treated as unresolved/unpriced
      priced,
      publishedToOnlineStore: ch?.publishedToOnlineStore ?? false,
      inStock: ch?.availableForSale ?? false,
    }).offerable;
    if (!offerable) {
      return { status: 'no-gift', reason: 'gift-unavailable', subtotal: resolved.subtotal };
    }
  }

  const domainTier = campaign.tiers.find((t) => t.id === winning.tierId) as Tier;
  // Defense-in-depth: minting is a synchronous Shopify call on the checkout-click path. Post-3c-C2 the
  // codes are eager-minted at activate so this just READS the stored code — but if a mint must run here
  // and FAILS (Shopify userError, empty scope, etc.), DEGRADE to no-gift rather than throw → the
  // /validate route must never 500/hang the storefront widget. The real cause is logged for triage.
  let mapping;
  try {
    mapping = await deps.mappingStore.getOrCreate(
      {
        campaignId: campaign.id,
        tierPosition: domainTier.position,
        resolvedGiftSetHash: resolvedGiftSetHash(winning.gifts),
        configVersionHash: campaign.configVersionHash,
      },
      {
        title: `${campaign.name} — tier ${domainTier.position}`,
        giftVariantIds,
        minimumSubtotal: domainTier.baseThreshold,
        qualifyingCollectionId: deps.qualifyingCollectionId,
        startsAt: campaign.startsAt.toISOString(),
        endsAt: campaign.endsAt.toISOString(),
        combinesWith: deps.giftCombinesWith ?? GIFT_COMBINES_WITH,
      },
    );
  } catch (err) {
    console.error('[validate] gift-code mint failed; degrading to no-gift', err);
    return { status: 'no-gift', reason: 'gift-unavailable', subtotal: resolved.subtotal };
  }
  if (mapping.code === null) {
    return { status: 'no-gift', reason: 'gift-unavailable', subtotal: resolved.subtotal };
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
