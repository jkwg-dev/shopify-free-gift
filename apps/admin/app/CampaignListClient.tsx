'use client';

// Read-only campaign list (Phase 3b Stage A) + Create/Edit entry points (Stage B). Fetches the
// JWT-authed list and renders Polaris rows. "Create campaign" and per-row "Edit" call back to the
// AdminApp shell, which swaps in the editor. Edit is offered only for INACTIVE drafts — editing an
// active campaign is deferred to Stage C (and the server refuses it).
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authedFetch('/api/admin/campaigns');
        const data = (await res.json()) as { campaigns: readonly CampaignListRow[] };
        if (!cancelled) {
          setRows(data.campaigns);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page
      title="Free Gift campaigns"
      primaryAction={{ content: 'Create campaign', onAction: onCreate }}
    >
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
        <BlockStack gap="400">
          {rows.map((c) => (
            <Card key={c.id}>
              <BlockStack gap="200">
                <InlineStack gap="200" align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {c.name}
                    </Text>
                    <StatusBadge status={c.status} />
                  </InlineStack>
                  <Button
                    onClick={() => onEdit(c.id)}
                    disabled={c.status !== 'inactive'}
                    accessibilityLabel={`Edit ${c.name}`}
                  >
                    Edit
                  </Button>
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
          ))}
        </BlockStack>
      )}
    </Page>
  );
}
