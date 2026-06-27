// Server-authoritative builder for the read-only campaign-config endpoint (GET /apps/free-gift/config,
// Phase 5b-2). Returns the STRUCTURE the storefront perception UI renders — every tier's enforced
// threshold and its gift options enriched with product id + label + availability. NOT the /validate
// result: /validate stays the per-cart authority and the only minting path. Reuses presentmentThreshold
// (the invariant: the figure shown == the figure /validate enforces) so display and enforcement never
// diverge.
import type {
  CampaignConfigRequest,
  CampaignConfigResponse,
  GiftItemView,
  GiftOptionView,
  Money,
  TierConfig,
} from '@free-gift-engine/core';
import type { VariantMeta, VariantPricing } from '@free-gift-engine/shopify';
import type { Tier } from '../domain.js';
import {
  type ActiveCampaignContext,
  parsePresentmentRate,
  presentmentThreshold,
} from './service.js';

export type ConfigServiceDeps = {
  readonly resolveActiveCampaign: (shopDomain: string) => Promise<ActiveCampaignContext | null>;
  readonly priceVariants: (
    variantIds: readonly string[],
    context: { readonly country: string },
  ) => Promise<readonly VariantPricing[]>;
  // Product id + titles per gift variant (the stored config holds only id + variantId).
  readonly fetchVariantMeta: (variantIds: readonly string[]) => Promise<readonly VariantMeta[]>;
};

const DEFAULT_VARIANT_TITLE = 'Default Title'; // Shopify's sentinel for a single-variant product.

// Display label: the variant's own option value ('Ice', 'L') when it has one, else the product name
// (single-variant gift products whose variant title is the 'Default Title' sentinel).
function labelFor(meta: VariantMeta): string {
  return meta.variantTitle && meta.variantTitle !== DEFAULT_VARIANT_TITLE
    ? meta.variantTitle
    : meta.productTitle;
}

// Every gift variant referenced by any tier (OR options + AND gifts).
function allGiftVariantIds(tiers: readonly Tier[]): string[] {
  const ids = new Set<string>();
  for (const tier of tiers) {
    if (tier.gift.kind === 'AND') {
      for (const g of tier.gift.gifts) ids.add(g.variantId);
    } else {
      for (const o of tier.gift.options) ids.add(o.variantId);
    }
  }
  return [...ids];
}

export async function resolveCampaignConfig(
  shopDomain: string,
  request: CampaignConfigRequest,
  deps: ConfigServiceDeps,
): Promise<CampaignConfigResponse> {
  const context = await deps.resolveActiveCampaign(shopDomain);
  if (context === null) {
    return { status: 'inactive' };
  }
  const { campaign, baseCurrency } = context;
  const presentment = request.presentmentCurrency;
  const rate = parsePresentmentRate(request.presentmentRate);

  // Resolve every tier's enforced threshold in the presentment currency — DERIVED from Shopify's rate
  // via the shared presentmentThreshold, so the widget shows exactly what /validate enforces. A
  // non-base market with no valid rate is not offered (inactive, never a partial offer).
  const thresholdByTier = new Map<string, Money>();
  for (const tier of campaign.tiers) {
    const threshold = presentmentThreshold(tier, presentment, baseCurrency, rate);
    if (threshold === null) {
      return { status: 'inactive' };
    }
    thresholdByTier.set(tier.id, threshold);
  }

  const giftVariantIds = allGiftVariantIds(campaign.tiers);
  const [pricing, meta] = await Promise.all([
    deps.priceVariants(giftVariantIds, { country: request.countryCode }),
    deps.fetchVariantMeta(giftVariantIds),
  ]);
  const availableById = new Map(pricing.map((p) => [p.id, p.availableForSale] as const));
  const metaById = new Map(meta.map((m) => [m.id, m] as const));

  // A variant is offerable only if it both prices in this market AND resolves to a product. A missing
  // entry (deleted / unpriceable) renders disabled — /validate's gift-unavailable is the backstop.
  const viewFor = (variantId: string): GiftItemView => {
    const m = metaById.get(variantId);
    return {
      variantId,
      productId: m?.productId ?? '',
      productLabel: m === undefined ? variantId : m.productTitle,
      variantLabel: m === undefined ? variantId : labelFor(m),
      available: (availableById.get(variantId) ?? false) && m !== undefined,
      imageUrl: m?.imageUrl ?? null,
    };
  };

  const tiers: TierConfig[] = campaign.tiers.map((tier) => {
    const threshold = thresholdByTier.get(tier.id) as Money;
    if (tier.gift.kind === 'AND') {
      const gifts: GiftItemView[] = tier.gift.gifts.map((g) => viewFor(g.variantId));
      return { tierId: tier.id, position: tier.position, threshold, gift: { kind: 'AND', gifts } };
    }
    const options: GiftOptionView[] = tier.gift.options.map((o) => ({
      optionId: o.id,
      ...viewFor(o.variantId),
    }));
    return { tierId: tier.id, position: tier.position, threshold, gift: { kind: 'OR', options } };
  });

  return {
    status: 'active',
    currency: presentment,
    declineEnabled: campaign.declineEnabled,
    tiers,
  };
}
