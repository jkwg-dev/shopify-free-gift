'use client';

// Campaign list (Phase 3b A) + Create/Edit (B) + Activate/Deactivate (Phase 3c Stage C1). Fetches the
// JWT-authed list and renders Polaris rows. Activate is offered on an INACTIVE draft; Deactivate on the
// active one. Activating while another FGE campaign is active is REJECTED server-side (≤ 1 active) and
// the message is surfaced here — the confirm-and-replace swap is Stage C3. Edit stays offered only on
// inactive drafts (editing an active campaign is still refused).
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { authedFetch } from './appBridge.js';
import type { CampaignListRow, CampaignStatus, TierSummary } from '../src/admin/campaignList.js';

const STATUS_TONE: Record<CampaignStatus, 'success' | 'info' | 'warning' | undefined> = {
  live: 'success',
  scheduled: 'info',
  ended: 'warning',
  inactive: undefined,
};

// Display only; minor→major as /100 is approximate for zero-decimal currencies — fine for this summary.
function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      amountMinor / 100,
    );
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

function tierLine(t: TierSummary): string {
  const gift = t.kind === 'AND' ? `AND (${t.giftCount} gifts)` : `OR (choose 1 of ${t.giftCount})`;
  return `Tier ${t.position}: ${formatMoney(t.threshold.amountMinor, t.threshold.currency)} — ${gift}`;
}

// exactOptionalPropertyTypes: Badge's `tone` can't be passed as explicit `undefined`, so omit it for
// the neutral (inactive) status rather than passing undefined.
function StatusBadge({ status }: { status: CampaignStatus }): React.JSX.Element {
  const tone = STATUS_TONE[status];
  return tone === undefined ? <Badge>{status}</Badge> : <Badge tone={tone}>{status}</Badge>;
}

export function CampaignListClient({
  onCreate,
  onEdit,
}: {
  readonly onCreate: () => void;
  readonly onEdit: (id: string) => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<readonly CampaignListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await authedFetch('/api/admin/campaigns');
      const data = (await res.json()) as { campaigns: readonly CampaignListRow[] };
      setRows(data.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (id: string, action: 'activate' | 'deactivate'): Promise<void> => {
    setActingId(id);
    setActionError(null);
    try {
      await authedFetch(`/api/admin/campaigns/${id}/${action}`, { method: 'POST' });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  };

  return (
    <Page
      title="Free Gift campaigns"
      primaryAction={{ content: 'Create campaign', onAction: onCreate }}
    >
      <BlockStack gap="400">
        {actionError !== null ? (
          <Banner
            tone="warning"
            title="Couldn't change activation"
            onDismiss={() => setActionError(null)}
          >
            {actionError}
          </Banner>
        ) : null}

        {error !== null ? (
          <Banner tone="critical" title="Couldn't load campaigns">
            {error}
          </Banner>
        ) : rows === null ? (
          <Spinner accessibilityLabel="Loading campaigns" />
        ) : rows.length === 0 ? (
          <Card>
            <Text as="p">No campaigns yet. Create your first draft.</Text>
          </Card>
        ) : (
          rows.map((c) => {
            const isInactive = c.status === 'inactive';
            return (
              <Card key={c.id}>
                <BlockStack gap="200">
                  <InlineStack gap="200" align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {c.name}
                      </Text>
                      <StatusBadge status={c.status} />
                    </InlineStack>
                    <InlineStack gap="200">
                      {isInactive ? (
                        <Button
                          variant="primary"
                          onClick={() => void act(c.id, 'activate')}
                          loading={actingId === c.id}
                          accessibilityLabel={`Activate ${c.name}`}
                        >
                          Activate
                        </Button>
                      ) : (
                        <Button
                          tone="critical"
                          onClick={() => void act(c.id, 'deactivate')}
                          loading={actingId === c.id}
                          accessibilityLabel={`Deactivate ${c.name}`}
                        >
                          Deactivate
                        </Button>
                      )}
                      <Button
                        onClick={() => onEdit(c.id)}
                        disabled={!isInactive}
                        accessibilityLabel={`Edit ${c.name}`}
                      >
                        Edit
                      </Button>
                    </InlineStack>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {`${new Date(c.startsAt).toLocaleString()} → ${new Date(c.endsAt).toLocaleString()} (${c.displayTimezone})`}
                  </Text>
                  <BlockStack gap="100">
                    {c.tiers.map((t) => (
                      <Text as="p" key={t.position}>
                        {tierLine(t)}
                      </Text>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            );
          })
        )}
      </BlockStack>
    </Page>
  );
}
