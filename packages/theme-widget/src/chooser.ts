// OR/variant chooser + decline checkbox (Phase 5b-2a). DOM-only rendering from the campaign-config
// structure; the pure parts (grouping, default selection) live in choices.ts and are unit-tested.
// Minimal markup/styling for 5b-2a — the progress graph, polish, mobile, and full a11y are 5b-2b.
//
// Every OR option is a distinct radio (no product-level dedup, consistent with the reconciler).
// Sibling variants of one product are wrapped in a group so they read as a variant selector, and an
// out-of-stock option is disabled (config availability) — /validate's gift-unavailable is the backstop.
import type { CampaignConfigResponse, TierConfig } from '@free-gift-engine/core';
import { groupGiftOptionsByProduct } from './choices.js';

export type ChooserState = {
  readonly choices: Readonly<Record<string, string>>;
  readonly declined: boolean;
};

export type ChooserHandlers = {
  readonly onChoose: (tierId: string, optionId: string) => void;
  readonly onDeclineToggle: (declined: boolean) => void;
};

export function renderChooser(
  mount: HTMLElement,
  config: CampaignConfigResponse,
  state: ChooserState,
  handlers: ChooserHandlers,
): void {
  mount.textContent = '';
  if (config.status !== 'active') {
    return;
  }
  const root = document.createElement('div');
  root.className = 'fge-chooser';

  if (config.declineEnabled) {
    root.append(renderDecline(state, handlers));
  }
  for (const tier of config.tiers) {
    if (tier.gift.kind === 'OR') {
      root.append(renderOrTier(tier, state, handlers));
    }
  }
  mount.append(root);
}

// "Add my free gift" — checked by default (declined=false); unchecking removes the gift.
function renderDecline(state: ChooserState, handlers: ChooserHandlers): HTMLElement {
  const label = document.createElement('label');
  label.className = 'fge-decline';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !state.declined;
  cb.addEventListener('change', () => handlers.onDeclineToggle(!cb.checked));
  label.append(cb, document.createTextNode(' Add my free gift'));
  return label;
}

function renderOrTier(
  tier: TierConfig,
  state: ChooserState,
  handlers: ChooserHandlers,
): HTMLElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'fge-tier';
  fieldset.dataset['tierId'] = tier.tierId;
  const legend = document.createElement('legend');
  legend.textContent = 'Choose your free gift';
  fieldset.append(legend);

  const selected = state.choices[tier.tierId];
  if (tier.gift.kind !== 'OR') {
    return fieldset;
  }
  // Group siblings of one product so they render as a variant selector, not separate cards.
  for (const group of groupGiftOptionsByProduct(tier.gift.options)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'fge-group';
    for (const opt of group.options) {
      const label = document.createElement('label');
      label.className = 'fge-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `fge-tier-${tier.tierId}`;
      radio.value = opt.optionId;
      radio.checked = opt.optionId === selected;
      radio.disabled = !opt.available;
      radio.addEventListener('change', () => handlers.onChoose(tier.tierId, opt.optionId));
      const text = opt.available ? opt.variantLabel : `${opt.variantLabel} (out of stock)`;
      label.append(radio, document.createTextNode(` ${text}`));
      groupEl.append(label);
    }
    fieldset.append(groupEl);
  }
  return fieldset;
}
