import { money } from '@free-gift-engine/core';
import { describe, expect, it } from 'vitest';
import type { CampaignDTO } from '../contract.js';
import {
  EditorParseError,
  campaignToEditorView,
  editorInputToCampaignInput,
  giftVariantIdsOfCampaign,
} from './editorMapping.js';
import type { CampaignEditorInput, EditorTier } from './editorTypes.js';

function editorTier(overrides: Partial<EditorTier> = {}): EditorTier {
  return {
    position: 1,
    thresholdAmount: '50.00',
    thresholdCurrency: 'USD',
    giftKind: 'OR',
    gifts: [{ variantId: 'gid://shopify/ProductVariant/111', title: 'Hat' }],
    marketThresholds: [],
    ...overrides,
  };
}

function editorInput(overrides: Partial<CampaignEditorInput> = {}): CampaignEditorInput {
  return {
    name: '  Summer  ',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-07-31T00:00:00.000Z',
    declineEnabled: true,
    suppression: 'highest-only',
    tiers: [editorTier()],
    ...overrides,
  };
}

describe('editorInputToCampaignInput', () => {
  it('parses a decimal threshold to minor units with the currency exponent (USD: x100)', () => {
    const dto = editorInputToCampaignInput(editorInput());
    expect(dto.tiers[0]?.baseThreshold).toEqual(money(5000, 'USD'));
    expect(dto.name).toBe('Summer'); // trimmed
    expect(dto.displayTimezone).toBe('UTC');
  });

  it('applies the zero-decimal exponent for JPY (no x100)', () => {
    const dto = editorInputToCampaignInput(
      editorInput({ tiers: [editorTier({ thresholdAmount: '5000', thresholdCurrency: 'JPY' })] }),
    );
    expect(dto.tiers[0]?.baseThreshold).toEqual(money(5000, 'JPY'));
  });

  it('derives a stable OR option id from the variant GID tail', () => {
    const dto = editorInputToCampaignInput(editorInput());
    const gift = dto.tiers[0]?.gift;
    expect(gift).toEqual({
      kind: 'OR',
      options: [{ id: '111', variantId: 'gid://shopify/ProductVariant/111' }],
    });
  });

  it('maps an AND tier to gifts', () => {
    const dto = editorInputToCampaignInput(
      editorInput({
        tiers: [
          editorTier({
            giftKind: 'AND',
            gifts: [
              { variantId: 'gid://shopify/ProductVariant/1', title: 'A' },
              { variantId: 'gid://shopify/ProductVariant/2', title: 'B' },
            ],
          }),
        ],
      }),
    );
    expect(dto.tiers[0]?.gift).toEqual({
      kind: 'AND',
      gifts: [
        { variantId: 'gid://shopify/ProductVariant/1' },
        { variantId: 'gid://shopify/ProductVariant/2' },
      ],
    });
  });

  it('parses market thresholds (amount -> resolvedThreshold, FX string -> number)', () => {
    const dto = editorInputToCampaignInput(
      editorInput({
        tiers: [
          editorTier({
            marketThresholds: [
              {
                market: 'JP',
                presentmentCurrency: 'JPY',
                amount: '7000',
                manualFxRate: '140',
                roundingRule: 'none',
              },
            ],
          }),
        ],
      }),
    );
    expect(dto.tiers[0]?.marketThresholds[0]).toEqual({
      market: 'JP',
      presentmentCurrency: 'JPY',
      manualFxRate: 140,
      roundingRule: 'none',
      resolvedThreshold: money(7000, 'JPY'),
    });
  });

  it('treats a blank FX rate as null', () => {
    const dto = editorInputToCampaignInput(
      editorInput({
        tiers: [
          editorTier({
            marketThresholds: [
              {
                market: 'US',
                presentmentCurrency: 'USD',
                amount: '50.00',
                manualFxRate: null,
                roundingRule: 'none',
              },
            ],
          }),
        ],
      }),
    );
    expect(dto.tiers[0]?.marketThresholds[0]?.manualFxRate).toBeNull();
  });

  it('throws EditorParseError on an amount with too much precision for the currency', () => {
    expect(() =>
      editorInputToCampaignInput(
        editorInput({
          tiers: [editorTier({ thresholdAmount: '50.005', thresholdCurrency: 'USD' })],
        }),
      ),
    ).toThrow(EditorParseError);
  });

  it('throws EditorParseError on a non-numeric amount', () => {
    expect(() =>
      editorInputToCampaignInput(editorInput({ tiers: [editorTier({ thresholdAmount: 'abc' })] })),
    ).toThrow(EditorParseError);
  });
});

const campaignDto = (): CampaignDTO => ({
  id: 'c1',
  shopId: 's1',
  name: 'Summer',
  suppression: 'highest-only',
  declineEnabled: true,
  startsAt: '2026-07-01T00:00:00.000Z',
  endsAt: '2026-07-31T00:00:00.000Z',
  displayTimezone: 'UTC',
  active: false,
  configVersionHash: 'h',
  tiers: [
    {
      id: 't1',
      position: 1,
      baseThreshold: money(5000, 'USD'),
      gift: { kind: 'OR', options: [{ id: '111', variantId: 'gid://shopify/ProductVariant/111' }] },
      marketThresholds: [
        {
          market: 'JP',
          presentmentCurrency: 'JPY',
          manualFxRate: 140,
          roundingRule: 'none',
          resolvedThreshold: money(7000, 'JPY'),
        },
      ],
    },
  ],
});

describe('campaignToEditorView', () => {
  it('formats minor units back to decimals and attaches gift titles', () => {
    const titles = new Map([['gid://shopify/ProductVariant/111', 'Cool Hat']]);
    const view = campaignToEditorView(campaignDto(), titles);
    expect(view.id).toBe('c1');
    expect(view.active).toBe(false);
    const tier = view.tiers[0];
    expect(tier?.thresholdAmount).toBe('50.00');
    expect(tier?.thresholdCurrency).toBe('USD');
    expect(tier?.giftKind).toBe('OR');
    expect(tier?.gifts).toEqual([
      { variantId: 'gid://shopify/ProductVariant/111', title: 'Cool Hat' },
    ]);
    expect(tier?.marketThresholds[0]).toEqual({
      market: 'JP',
      presentmentCurrency: 'JPY',
      amount: '7000',
      manualFxRate: '140',
      roundingRule: 'none',
    });
  });

  it('falls back to the variant id when no title is known', () => {
    const view = campaignToEditorView(campaignDto(), new Map());
    expect(view.tiers[0]?.gifts[0]?.title).toBe('gid://shopify/ProductVariant/111');
  });
});

describe('giftVariantIdsOfCampaign', () => {
  it('collects and de-duplicates gift variant ids', () => {
    const dto = campaignDto();
    expect(giftVariantIdsOfCampaign(dto)).toEqual(['gid://shopify/ProductVariant/111']);
  });
});
