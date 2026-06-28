'use client';

// Campaign + tier editor (Phase 3b Stage B). Creates or edits an INACTIVE draft — there is no
// activate/provision here (Stage C). Each tier has ONE threshold in the shop's BASE currency (the
// multi-currency FX track is separate); the server applies the currency exponent and validates.
// Suppression is fixed to highest-tier-only and shown read-only. Gift variants are chosen with the
// App Bridge variant resource picker, and their display labels are resolved server-side (so they
// match the edit view). Saving POSTs (create) or PUTs (edit) with the App Bridge session token; the
// server is the source of truth for validation, so this surfaces server errors.
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  Modal,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { authedFetch, pickVariantIds, resolveVariantLabels } from './appBridge.js';
import type {
  CampaignEditorInput,
  CampaignEditorView,
  EditorGiftVariant,
  EditorTier,
  GiftKind,
} from '../src/admin/editorTypes.js';

// Local row identity for React keys (the wire types carry no id).
let keySeq = 0;
const nextKey = (): string => `row-${(keySeq += 1)}`;

type TierForm = EditorTier & { readonly key: string };

const GIFT_KIND_OPTIONS = [
  { label: 'Choose one (OR)', value: 'OR' },
  { label: 'Get all (AND)', value: 'AND' },
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

function defaultStart(): string {
  return isoToLocal(new Date().toISOString());
}
function defaultEnd(): string {
  return isoToLocal(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString());
}

export function CampaignEditor({
  campaignId,
  baseCurrency,
  onDone,
  onCancel,
}: {
  readonly campaignId?: string;
  readonly baseCurrency: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [loading, setLoading] = useState(campaignId !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [startsLocal, setStartsLocal] = useState(defaultStart);
  const [endsLocal, setEndsLocal] = useState(defaultEnd);
  const [declineEnabled, setDeclineEnabled] = useState(true);
  const [tiers, setTiers] = useState<readonly TierForm[]>([blankTier(baseCurrency)]);
  // Whether the campaign was LIVE when opened — saving then SUPERSEDES (confirm first).
  const [wasActive, setWasActive] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);

  // Load the existing draft for editing. Threshold is forced to the base currency and per-market rows
  // are dropped (the editor is now single-base-currency); the loaded amount string is kept.
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
        setWasActive(view.active);
        setTiers(
          view.tiers.map((t) => ({
            ...t,
            key: nextKey(),
            thresholdCurrency: baseCurrency,
            marketThresholds: [],
          })),
        );
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
  }, [campaignId, baseCurrency]);

  const patchTier = (key: string, patch: Partial<EditorTier>): void =>
    setTiers((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  const addTier = (): void =>
    setTiers((prev) => [...prev, { ...blankTier(baseCurrency), position: prev.length + 1 }]);

  const removeTier = (key: string): void => setTiers((prev) => prev.filter((t) => t.key !== key));

  // Pick variants (GIDs), resolve their labels server-side, append (dedup by variant id).
  const addGifts = async (key: string): Promise<void> => {
    try {
      const ids = await pickVariantIds();
      if (ids.length === 0) {
        return;
      }
      const labels = await resolveVariantLabels(ids);
      setTiers((prev) =>
        prev.map((t) => {
          if (t.key !== key) {
            return t;
          }
          const have = new Set(t.gifts.map((g) => g.variantId));
          const added: EditorGiftVariant[] = ids
            .filter((id) => !have.has(id))
            .map((id) => ({ variantId: id, title: labels[id] ?? id }));
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

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const body: CampaignEditorInput = {
      name,
      startsAt: localToIso(startsLocal),
      endsAt: localToIso(endsLocal),
      declineEnabled,
      suppression: 'highest-only',
      // Single base-currency threshold per tier; no per-market rows (FX track is separate).
      tiers: tiers.map((t) => ({
        position: t.position,
        thresholdAmount: t.thresholdAmount,
        thresholdCurrency: baseCurrency,
        giftKind: t.giftKind,
        gifts: t.gifts,
        marketThresholds: [],
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

  // Editing a LIVE campaign supersedes it (shoppers see the change) — confirm first. A draft saves
  // directly.
  const requestSave = (): void => {
    if (wasActive) {
      setConfirmLive(true);
    } else {
      void save();
    }
  };
  const saveLabel = wasActive ? 'Update live campaign' : 'Save draft';

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
      primaryAction={{ content: saveLabel, onAction: requestSave, disabled: saving }}
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
                    label={`Threshold (${baseCurrency})`}
                    value={tier.thresholdAmount}
                    onChange={(v) => patchTier(tier.key, { thresholdAmount: v })}
                    autoComplete="off"
                    placeholder="500.00"
                    suffix={baseCurrency}
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
                <InlineStack gap="200" blockAlign="center">
                  <Button onClick={() => void addGifts(tier.key)}>Add gift variants</Button>
                  <Text as="span" tone="subdued">
                    Tip: expand a product in the picker to choose specific variants.
                  </Text>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        ))}

        <InlineStack align="space-between">
          <Button onClick={addTier}>Add tier</Button>
          <Button variant="primary" onClick={requestSave} loading={saving}>
            {saveLabel}
          </Button>
        </InlineStack>
      </BlockStack>

      <Modal
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="Update the live campaign?"
        primaryAction={{
          content: 'Update',
          onAction: () => {
            setConfirmLive(false);
            void save();
          },
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirmLive(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            Shoppers will immediately see the new gifts/tiers. The campaign stays live throughout
            (its current codes are replaced atomically). To change the schedule instead, deactivate
            first.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
