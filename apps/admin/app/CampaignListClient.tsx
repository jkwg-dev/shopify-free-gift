'use client';

// Read-only campaign list (Phase 3b Stage A). Gets an App Bridge session token (window.shopify.idToken)
// and calls GET /api/admin/campaigns with it as a Bearer token (the new JWT boundary). Renders the
// returned view-model rows with Polaris. No mutation — create/edit/activate are Stage B/C.
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineStack,
  Page,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useEffect, useState } from 'react';
import type { CampaignListRow, CampaignStatus, TierSummary } from '../src/admin/campaignList.js';

type AppBridge = { idToken: () => Promise<string> };
declare global {
  interface Window {
    shopify?: AppBridge;
  }
}

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

export function CampaignListClient(): React.JSX.Element {
  const [rows, setRows] = useState<readonly CampaignListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bridge = window.shopify;
        if (bridge === undefined) {
          throw new Error('App Bridge unavailable — open this app from your Shopify admin.');
        }
        const token = await bridge.idToken();
        const res = await fetch('/api/admin/campaigns', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
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
    <Page title="Free Gift campaigns">
      {error !== null ? (
        <Banner tone="critical" title="Couldn't load campaigns">
          {error}
        </Banner>
      ) : rows === null ? (
        <Spinner accessibilityLabel="Loading campaigns" />
      ) : rows.length === 0 ? (
        <Card>
          <Text as="p">No campaigns yet.</Text>
        </Card>
      ) : (
        <BlockStack gap="400">
          {rows.map((c) => (
            <Card key={c.id}>
              <BlockStack gap="200">
                <InlineStack gap="200" align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {c.name}
                  </Text>
                  <StatusBadge status={c.status} />
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
