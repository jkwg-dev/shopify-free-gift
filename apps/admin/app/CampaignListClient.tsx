'use client';

// Campaign list (Phase 3b A) + Create/Edit (B) + Activate/Deactivate with confirm-and-replace
// (Phase 3c). Fetches the JWT-authed list and renders Polaris rows. Activate is offered on an INACTIVE
// draft; Deactivate on the active one. Activating while another FGE campaign is live returns a 409
// (requiresConfirmation) → we show a confirm dialog → on confirm, re-POST with confirmReplace=true and
// the server performs the atomic swap (and tears down the replaced campaign's codes). Edit stays
// offered only on inactive drafts.
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Modal,
  Page,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { authedFetch, authedFetchRaw } from './appBridge.js';
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

type ApiErrorBody = {
  error?: { message?: string; requiresConfirmation?: boolean };
};

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
  // Pending confirm-and-replace: the campaign id being activated + the server's message.
  const [confirm, setConfirm] = useState<{ id: string; message: string } | null>(null);

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

  const activate = async (id: string, confirmReplace: boolean): Promise<void> => {
    setActingId(id);
    setActionError(null);
    try {
      const res = await authedFetchRaw(`/api/admin/campaigns/${id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmReplace }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
        if (body?.error?.requiresConfirmation === true) {
          setConfirm({ id, message: body.error.message ?? 'Replace the active campaign?' });
          return; // wait for the dialog; the spinner clears in finally
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
        setActionError(body?.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  };

  const deactivate = async (id: string): Promise<void> => {
    setActingId(id);
    setActionError(null);
    try {
      await authedFetch(`/api/admin/campaigns/${id}/deactivate`, { method: 'POST' });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  };

  const onConfirmReplace = (): void => {
    if (confirm === null) {
      return;
    }
    const { id } = confirm;
    setConfirm(null);
    void activate(id, true);
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
                          onClick={() => void activate(c.id, false)}
                          loading={actingId === c.id}
                          accessibilityLabel={`Activate ${c.name}`}
                        >
                          Activate
                        </Button>
                      ) : (
                        <Button
                          tone="critical"
                          onClick={() => void deactivate(c.id)}
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

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Replace the active campaign?"
        primaryAction={{ content: 'Replace', destructive: true, onAction: onConfirmReplace }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirm(null) }]}
      >
        <Modal.Section>
          <Text as="p">{confirm?.message ?? ''}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
