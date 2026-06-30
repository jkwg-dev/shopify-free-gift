// Server-side mapping between the editor wire shape (decimal strings) and the frozen contract DTOs
// (Money minor units). The currency exponent is applied HERE via packages/shopify's
// decimalToMinorUnits / minorUnitsToDecimal — the one parse/format boundary (CLAUDE.md). Pure and
// unit-tested. Imports the shopify package at value level, so it runs ONLY server-side (the route);
// the client uses editorTypes.ts (type-only) and never imports this.
import type { GiftConfig, Money } from '@free-gift-engine/core';
import { decimalToMinorUnits, minorUnitsToDecimal } from '@free-gift-engine/shopify';
import type { CampaignDTO, CampaignInputDTO, MarketThresholdDTO, TierDTO } from '../contract.js';
import type {
  CampaignEditorInput,
  CampaignEditorView,
  EditorGiftVariant,
  EditorTier,
} from './editorTypes.js';

// Thrown when an admin-entered decimal amount can't be parsed for its currency (bad format or more
// precision than the currency allows). The route maps it to a 400 VALIDATION ApiError.
export class EditorParseError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'EditorParseError';
  }
}

function parseMoney(amount: string, currency: string, field: string): Money {
  try {
    return { amountMinor: decimalToMinorUnits(amount, currency), currency };
  } catch (err) {
    throw new EditorParseError(
      field,
      err instanceof Error ? err.message : `Invalid amount "${amount}"`,
    );
  }
}

function parseFxRate(rate: string | null, field: string): number | null {
  if (rate === null || rate.trim().length === 0) {
    return null;
  }
  const value = Number(rate);
  if (!Number.isFinite(value)) {
    throw new EditorParseError(field, `Invalid FX rate "${rate}"`);
  }
  return value;
}

// Derive a stable OR-option id from the variant id (the GID's numeric tail). Deterministic across
// edits and unique because validateCampaignConfig forbids the same variant twice in a tier.
function optionIdFor(variantId: string): string {
  const tail = variantId.split('/').pop();
  return tail !== undefined && tail.length > 0 ? tail : variantId;
}

function giftFromEditor(tier: EditorTier): GiftConfig {
  if (tier.giftKind === 'AND') {
    return { kind: 'AND', gifts: tier.gifts.map((g) => ({ variantId: g.variantId })) };
  }
  return {
    kind: 'OR',
    options: tier.gifts.map((g) => ({ id: optionIdFor(g.variantId), variantId: g.variantId })),
  };
}

function tierFromEditor(tier: EditorTier): TierDTO {
  return {
    position: tier.position,
    baseThreshold: parseMoney(
      tier.thresholdAmount,
      tier.thresholdCurrency,
      `tier ${tier.position} threshold`,
    ),
    gift: giftFromEditor(tier),
    marketThresholds: tier.marketThresholds.map((m) => ({
      market: m.market,
      presentmentCurrency: m.presentmentCurrency,
      manualFxRate: parseFxRate(m.manualFxRate, `tier ${tier.position} market ${m.market} FX`),
      roundingRule: m.roundingRule,
      resolvedThreshold: parseMoney(
        m.amount,
        m.presentmentCurrency,
        `tier ${tier.position} market ${m.market} amount`,
      ),
    })),
  };
}

// editor input (decimals) -> frozen CampaignInputDTO (Money). Throws EditorParseError on bad amounts.
export function editorInputToCampaignInput(input: CampaignEditorInput): CampaignInputDTO {
  return {
    name: input.name.trim(),
    suppression: input.suppression,
    declineEnabled: input.declineEnabled,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    displayTimezone: 'UTC', // Stage B edits schedule in UTC; per-zone display is a later concern.
    qualifyingCollectionId: input.qualifyingCollectionId ?? null,
    tiers: input.tiers.map(tierFromEditor),
  };
}

function giftToEditorVariants(
  gift: GiftConfig,
  titles: ReadonlyMap<string, string>,
): EditorGiftVariant[] {
  const refs = gift.kind === 'AND' ? gift.gifts : gift.options;
  return refs.map((r) => ({
    variantId: r.variantId,
    title: titles.get(r.variantId) ?? r.variantId,
  }));
}

function marketToEditor(m: MarketThresholdDTO): EditorMarketThresholdView {
  return {
    market: m.market,
    presentmentCurrency: m.presentmentCurrency,
    amount: minorUnitsToDecimal(m.resolvedThreshold.amountMinor, m.resolvedThreshold.currency),
    manualFxRate: m.manualFxRate === null ? null : String(m.manualFxRate),
    roundingRule: m.roundingRule,
  };
}

type EditorMarketThresholdView = CampaignEditorView['tiers'][number]['marketThresholds'][number];

// frozen CampaignDTO (Money) -> editor view (decimals + display titles). `titles` maps variant id ->
// display label; a missing entry (deleted/unresolvable variant) falls back to the id.
export function campaignToEditorView(
  campaign: CampaignDTO,
  titles: ReadonlyMap<string, string>,
  collectionTitle?: string | null,
): CampaignEditorView {
  return {
    id: campaign.id,
    active: campaign.active,
    name: campaign.name,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    declineEnabled: campaign.declineEnabled,
    suppression: campaign.suppression,
    qualifyingCollectionId: campaign.qualifyingCollectionId,
    qualifyingCollectionTitle: collectionTitle ?? null,
    tiers: [...campaign.tiers]
      .sort((a, b) => a.position - b.position)
      .map((tier) => ({
        position: tier.position,
        thresholdAmount: minorUnitsToDecimal(
          tier.baseThreshold.amountMinor,
          tier.baseThreshold.currency,
        ),
        thresholdCurrency: tier.baseThreshold.currency,
        giftKind: tier.gift.kind,
        gifts: giftToEditorVariants(tier.gift, titles),
        marketThresholds: tier.marketThresholds.map(marketToEditor),
      })),
  };
}

// Collect every gift variant id referenced by a campaign (for title enrichment on the edit view).
export function giftVariantIdsOfCampaign(campaign: CampaignDTO): string[] {
  const ids = campaign.tiers.flatMap((t) =>
    t.gift.kind === 'AND'
      ? t.gift.gifts.map((g) => g.variantId)
      : t.gift.options.map((o) => o.variantId),
  );
  return [...new Set(ids)];
}
