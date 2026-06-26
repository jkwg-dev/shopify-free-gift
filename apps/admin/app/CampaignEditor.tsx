'use client';

// Campaign + tier editor (Phase 3b Stage B). Creates or edits an INACTIVE draft — there is no
// activate/provision here (Stage C). Speaks the editor wire shape (decimal amount strings); the
// server applies the currency exponent and validates. Suppression is fixed to highest-tier-only and
// shown read-only. Gift variants are chosen with the App Bridge variant resource picker. Saving POSTs
// (create) or PUTs (edit) with the App Bridge session token; the server is the source of truth for
// validation, so this surfaces server errors rather than duplicating the rules.
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { authedFetch, pickVariants } from './appBridge.js';
import type {
  CampaignEditorInput,
  CampaignEditorView,
  EditorGiftVariant,
  EditorMarketThreshold,
  EditorTier,
  GiftKind,
} from '../src/admin/editorTypes.js';
import type { RoundingRule } from '../src/domain.js';

// Local row identity for React keys (the wire types carry no id).
let keySeq = 0;
const nextKey = (): string => `row-${(keySeq += 1)}`;

type TierForm = EditorTier & { readonly key: string };

const GIFT_KIND_OPTIONS = [
  { label: 'Choose one (OR)', value: 'OR' },
  { label: 'Get all (AND)', value: 'AND' },
];
const ROUNDING_OPTIONS: { label: string; value: RoundingRule }[] = [
  { label: 'No rounding', value: 'none' },
  { label: 'Up to nearest 100 minor units', value: 'up-to-nearest-minor-100' },
  { label: 'Up to nearest major unit', value: 'up-to-nearest-major' },
];

// datetime-local <-> ISO(UTC). The form treats the wall-clock value as UTC (labelled so).
const isoToLocal = (iso: string): string => (iso.length >= 16 ? iso.slice(0, 16) : iso);
function localToIso(local: string): string {
  if (local.length === 0) {
    return '';
  }
  const d = new Date(`${local}Z`);
  return Number.isNaN(d.getTime()) ? local : d.toISOString();
}

function blankTier(currency: string): TierForm {
  return {
    key: nextKey(),
    position: 1,
    thresholdAmount: '',
    thresholdCurrency: currency,
    giftKind: 'OR',
    gifts: [],
    marketThresholds: [],
  };
}

function blankMarket(): EditorMarketThreshold {
  return {
    market: '',
    presentmentCurrency: '',
    amount: '',
    manualFxRate: null,
    roundingRule: 'none',
  };
}

function defaultStart(): string {
  return isoToLocal(new Date().toISOString());
}
function defaultEnd(): string {
  return isoToLocal(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString());
}

export function CampaignEditor({
  campaignId,
  onDone,
  onCancel,
}: {
  readonly campaignId?: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const baseCurrency = 'USD'; // default for new tiers; editable per tier (shop base currency: 3C)
  const [loading, setLoading] = useState(campaignId !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [startsLocal, setStartsLocal] = useState(defaultStart);
  const [endsLocal, setEndsLocal] = useState(defaultEnd);
  const [declineEnabled, setDeclineEnabled] = useState(true);
  const [tiers, setTiers] = useState<readonly TierForm[]>([blankTier(baseCurrency)]);

  // Load the existing draft for editing.
  useEffect(() => {
    if (campaignId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authedFetch(`/api/admin/campaigns/${campaignId}`);
        const view = (await res.json()) as CampaignEditorView;
        if (cancelled) {
          return;
        }
        setName(view.name);
        setStartsLocal(isoToLocal(view.startsAt));
        setEndsLocal(isoToLocal(view.endsAt));
        setDeclineEnabled(view.declineEnabled);
        setTiers(view.tiers.map((t) => ({ ...t, key: nextKey() })));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const patchTier = (key: string, patch: Partial<EditorTier>): void =>
    setTiers((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  const addTier = (): void =>
    setTiers((prev) => [...prev, { ...blankTier(baseCurrency), position: prev.length + 1 }]);

  const removeTier = (key: string): void => setTiers((prev) => prev.filter((t) => t.key !== key));

  const addGifts = async (key: string): Promise<void> => {
    try {
      const picked = await pickVariants();
      if (picked.length === 0) {
        return;
      }
      setTiers((prev) =>
        prev.map((t) => {
          if (t.key !== key) {
            return t;
          }
          const have = new Set(t.gifts.map((g) => g.variantId));
          const added: EditorGiftVariant[] = picked.filter((p) => !have.has(p.variantId));
          return { ...t, gifts: [...t.gifts, ...added] };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const dropGift = (key: string, variantId: string): void =>
    setTiers((prev) =>
      prev.map((t) =>
        t.key === key ? { ...t, gifts: t.gifts.filter((g) => g.variantId !== variantId) } : t,
      ),
    );

  const patchTierMarkets = (
    key: string,
    fn: (markets: readonly EditorMarketThreshold[]) => readonly EditorMarketThreshold[],
  ): void =>
    setTiers((prev) =>
      prev.map((t) => (t.key === key ? { ...t, marketThresholds: fn(t.marketThresholds) } : t)),
    );
  const patchMarket = (key: string, index: number, patch: Partial<EditorMarketThreshold>): void =>
    patchTierMarkets(key, (markets) =>
      markets.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );
  const addMarket = (key: string): void =>
    patchTierMarkets(key, (markets) => [...markets, blankMarket()]);
  const removeMarket = (key: string, index: number): void =>
    patchTierMarkets(key, (markets) => markets.filter((_, i) => i !== index));

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const body: CampaignEditorInput = {
      name,
      startsAt: localToIso(startsLocal),
      endsAt: localToIso(endsLocal),
      declineEnabled,
      suppression: 'highest-only',
      tiers: tiers.map((t) => ({
        position: t.position,
        thresholdAmount: t.thresholdAmount,
        thresholdCurrency: t.thresholdCurrency,
        giftKind: t.giftKind,
        gifts: t.gifts,
        marketThresholds: t.marketThresholds,
      })),
    };
    try {
      const path =
        campaignId === undefined ? '/api/admin/campaigns' : `/api/admin/campaigns/${campaignId}`;
      await authedFetch(path, {
        method: campaignId === undefined ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Page title="Edit campaign">
        <Spinner accessibilityLabel="Loading campaign" />
      </Page>
    );
  }

  return (
    <Page
      title={campaignId === undefined ? 'Create campaign' : 'Edit campaign'}
      backAction={{ content: 'Campaigns', onAction: onCancel }}
      primaryAction={{ content: 'Save draft', onAction: () => void save(), disabled: saving }}
    >
      <BlockStack gap="400">
        {error !== null ? (
          <Banner tone="critical" title="Couldn't save">
            {error}
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="400">
            <FormLayout>
              <TextField
                label="Campaign name"
                value={name}
                onChange={setName}
                autoComplete="off"
                requiredIndicator
              />
              <FormLayout.Group>
                <TextField
                  label="Starts at (UTC)"
                  type="datetime-local"
                  value={startsLocal}
                  onChange={setStartsLocal}
                  autoComplete="off"
                />
                <TextField
                  label="Ends at (UTC)"
                  type="datetime-local"
                  value={endsLocal}
                  onChange={setEndsLocal}
                  autoComplete="off"
                />
              </FormLayout.Group>
              <Checkbox
                label="Allow shoppers to decline the gift"
                checked={declineEnabled}
                onChange={setDeclineEnabled}
              />
            </FormLayout>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone="subdued">
                Suppression:
              </Text>
              <Badge>Highest tier only</Badge>
              <Text as="span" tone="subdued">
                (fixed — cumulative needs Shopify Plus)
              </Text>
            </InlineStack>
          </BlockStack>
        </Card>

        {tiers.map((tier, tierIndex) => (
          <Card key={tier.key}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Tier {tierIndex + 1}
                </Text>
                <Button
                  tone="critical"
                  variant="plain"
                  onClick={() => removeTier(tier.key)}
                  disabled={tiers.length === 1}
                >
                  Remove tier
                </Button>
              </InlineStack>

              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Position"
                    type="number"
                    value={String(tier.position)}
                    onChange={(v) => patchTier(tier.key, { position: Number(v) || 0 })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Base threshold"
                    value={tier.thresholdAmount}
                    onChange={(v) => patchTier(tier.key, { thresholdAmount: v })}
                    autoComplete="off"
                    placeholder="50.00"
                  />
                  <TextField
                    label="Currency"
                    value={tier.thresholdCurrency}
                    onChange={(v) => patchTier(tier.key, { thresholdCurrency: v.toUpperCase() })}
                    autoComplete="off"
                  />
                </FormLayout.Group>
                <Select
                  label="Gift type"
                  options={GIFT_KIND_OPTIONS}
                  value={tier.giftKind}
                  onChange={(v) => patchTier(tier.key, { giftKind: v as GiftKind })}
                />
              </FormLayout>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  {tier.giftKind === 'OR'
                    ? 'Gift options (shopper chooses one)'
                    : 'Gifts (all given)'}
                </Text>
                {tier.gifts.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No gift variants yet.
                  </Text>
                ) : (
                  <BlockStack gap="100">
                    {tier.gifts.map((g) => (
                      <InlineStack key={g.variantId} align="space-between" blockAlign="center">
                        <Text as="span">{g.title}</Text>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => dropGift(tier.key, g.variantId)}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
                <InlineStack>
                  <Button onClick={() => void addGifts(tier.key)}>Add gift variants</Button>
                </InlineStack>
              </BlockStack>

              <Divider />

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Per-market thresholds
                </Text>
                {tier.marketThresholds.map((m, i) => (
                  <FormLayout key={`${tier.key}-m${i}`}>
                    <FormLayout.Group>
                      <TextField
                        label="Market"
                        value={m.market}
                        onChange={(v) => patchMarket(tier.key, i, { market: v })}
                        autoComplete="off"
                        placeholder="gid://shopify/Market/123 or handle"
                      />
                      <TextField
                        label="Currency"
                        value={m.presentmentCurrency}
                        onChange={(v) =>
                          patchMarket(tier.key, i, { presentmentCurrency: v.toUpperCase() })
                        }
                        autoComplete="off"
                      />
                      <TextField
                        label="Amount"
                        value={m.amount}
                        onChange={(v) => patchMarket(tier.key, i, { amount: v })}
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                    <FormLayout.Group>
                      <TextField
                        label="Manual FX rate (optional)"
                        value={m.manualFxRate ?? ''}
                        onChange={(v) =>
                          patchMarket(tier.key, i, { manualFxRate: v.length === 0 ? null : v })
                        }
                        autoComplete="off"
                      />
                      <Select
                        label="Rounding"
                        options={ROUNDING_OPTIONS}
                        value={m.roundingRule}
                        onChange={(v) =>
                          patchMarket(tier.key, i, { roundingRule: v as RoundingRule })
                        }
                      />
                      <div style={{ alignSelf: 'end' }}>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeMarket(tier.key, i)}
                        >
                          Remove market
                        </Button>
                      </div>
                    </FormLayout.Group>
                    <Divider />
                  </FormLayout>
                ))}
                <InlineStack>
                  <Button onClick={() => addMarket(tier.key)}>Add market threshold</Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        ))}

        <InlineStack align="space-between">
          <Button onClick={addTier}>Add tier</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            Save draft
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
