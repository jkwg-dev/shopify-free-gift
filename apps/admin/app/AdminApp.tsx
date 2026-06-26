'use client';

// Embedded admin shell (Phase 3b Stage B). A tiny client-side view switch between the campaign list
// and the editor (create or edit). Kept as in-component state rather than Next routes so the embedded
// iframe never has to re-thread shop/host params on navigation — simplest thing that works embedded.
import { useState } from 'react';
import { CampaignEditor } from './CampaignEditor.js';
import { CampaignListClient } from './CampaignListClient.js';

type View =
  | { readonly name: 'list' }
  | { readonly name: 'new' }
  | { readonly name: 'edit'; readonly id: string };

export function AdminApp(): React.JSX.Element {
  const [view, setView] = useState<View>({ name: 'list' });
  // Bump to force the list to remount and refetch after a save.
  const [listKey, setListKey] = useState(0);

  if (view.name === 'list') {
    return (
      <CampaignListClient
        key={listKey}
        onCreate={() => setView({ name: 'new' })}
        onEdit={(id) => setView({ name: 'edit', id })}
      />
    );
  }

  const onDone = (): void => {
    setListKey((k) => k + 1);
    setView({ name: 'list' });
  };
  const onCancel = (): void => setView({ name: 'list' });

  return view.name === 'edit' ? (
    <CampaignEditor campaignId={view.id} onDone={onDone} onCancel={onCancel} />
  ) : (
    <CampaignEditor onDone={onDone} onCancel={onCancel} />
  );
}
