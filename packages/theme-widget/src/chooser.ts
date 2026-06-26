// OR/variant chooser + decline checkbox (Phase 5b-2a). The render DECISION is a pure view-model
// (buildChooserModel) so it is unit-testable without a DOM; renderChooser just paints that model.
// Minimal markup/styling for 5b-2a — the progress graph, polish, mobile, and full a11y are 5b-2b.
//
// OR tiers: each option is a distinct radio (no product-level dedup, consistent with the reconciler);
// sibling variants of one product are grouped into a selector; out-of-stock options are disabled.
// AND tiers: BOTH gifts are unlocked together, so there is NO choice — render them as a bundled
// display, write nothing into `choices`. /validate's gift-unavailable is the backstop for OOS.
import type {
  CampaignConfigResponse,
  GiftItemView,
  Money,
  TierConfig,
} from '@free-gift-engine/core';
import { groupGiftOptionsByProduct, type GiftProductGroup } from './choices.js';

export type ChooserState = {
  readonly choices: Readonly<Record<string, string>>;
  readonly declined: boolean;
  // Gift VARIANT GIDs found unavailable at RUNTIME (e.g. a cart/add 422 for an unpublished/sold-out
  // gift). ORed into static config availability so the option is disabled + noted; the gift is never
  // shown as added when it wasn't. Defaults to empty.
  readonly unavailableVariantIds?: ReadonlySet<string>;
};

export type ChooserHandlers = {
  readonly onChoose: (tierId: string, optionId: string) => void;
  readonly onDeclineToggle: (declined: boolean) => void;
};

// --- pure view-model -----------------------------------------------------------------------------

// An OR tier the shopper picks ONE option from (grouped by product for the variant selector).
export type ChooserOrTier = {
  readonly kind: 'or';
  readonly tierId: string;
  readonly threshold: Money;
  readonly groups: readonly GiftProductGroup[];
  readonly selected: string | undefined;
};

// An AND tier: all gifts unlocked together, NO choice — a bundled display only.
export type ChooserAndTier = {
  readonly kind: 'and';
  readonly tierId: string;
  readonly threshold: Money;
  readonly items: readonly GiftItemView[];
  // True when any bundle item is unavailable — the gift can't be FULLY added (surface it; don't
  // silently deliver a partial bundle).
  readonly incomplete: boolean;
};

export type ChooserTier = ChooserOrTier | ChooserAndTier;

export type ChooserModel = {
  readonly declineEnabled: boolean;
  readonly declined: boolean;
  readonly tiers: readonly ChooserTier[];
};

// Build the render model from the campaign config + current selection. Returns null when there is no
// active campaign (nothing to render). Every tier is represented IN ORDER — OR as a chooser, AND as a
// bundled display — so all tiers render, not just the OR ones.
export function buildChooserModel(
  config: CampaignConfigResponse,
  state: ChooserState,
): ChooserModel | null {
  if (config.status !== 'active') {
    return null;
  }
  const unavailable = state.unavailableVariantIds ?? new Set<string>();
  // Effective availability = static config availability AND not runtime-unavailable.
  const isAvailable = (variantId: string, configAvailable: boolean): boolean =>
    configAvailable && !unavailable.has(variantId);

  const tiers = config.tiers.map((tier: TierConfig): ChooserTier => {
    if (tier.gift.kind === 'AND') {
      const items: GiftItemView[] = tier.gift.gifts.map((g) => ({
        ...g,
        available: isAvailable(g.variantId, g.available),
      }));
      return {
        kind: 'and',
        tierId: tier.tierId,
        threshold: tier.threshold,
        items,
        incomplete: items.some((i) => !i.available),
      };
    }
    const options = tier.gift.options.map((o) => ({
      ...o,
      available: isAvailable(o.variantId, o.available),
    }));
    return {
      kind: 'or',
      tierId: tier.tierId,
      threshold: tier.threshold,
      groups: groupGiftOptionsByProduct(options),
      selected: state.choices[tier.tierId],
    };
  });
  return { declineEnabled: config.declineEnabled, declined: state.declined, tiers };
}

// --- DOM rendering (manual-tested) ---------------------------------------------------------------

export function renderChooser(
  mount: HTMLElement,
  config: CampaignConfigResponse,
  state: ChooserState,
  handlers: ChooserHandlers,
): void {
  mount.textContent = '';
  const model = buildChooserModel(config, state);
  if (model === null) {
    return;
  }
  const root = document.createElement('div');
  root.className = 'fge-chooser';

  if (model.declineEnabled) {
    root.append(renderDecline(model.declined, handlers));
  }
  for (const tier of model.tiers) {
    root.append(tier.kind === 'or' ? renderOrTier(tier, handlers) : renderAndTier(tier));
  }
  mount.append(root);
}

// "Add my free gift" — checked by default (declined=false); unchecking removes the gift.
function renderDecline(declined: boolean, handlers: ChooserHandlers): HTMLElement {
  const label = document.createElement('label');
  label.className = 'fge-decline';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !declined;
  cb.addEventListener('change', () => handlers.onDeclineToggle(!cb.checked));
  label.append(cb, document.createTextNode(' Add my free gift'));
  return label;
}

function tierFieldset(tier: ChooserTier, legendText: string): HTMLFieldSetElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'fge-tier';
  fieldset.dataset['tierId'] = tier.tierId;
  const legend = document.createElement('legend');
  legend.textContent = legendText;
  fieldset.append(legend);
  const threshold = document.createElement('div');
  threshold.className = 'fge-threshold';
  threshold.textContent = `Spend ${formatMoney(tier.threshold)}`;
  fieldset.append(threshold);
  return fieldset;
}

function renderOrTier(tier: ChooserOrTier, handlers: ChooserHandlers): HTMLElement {
  const fieldset = tierFieldset(tier, 'Choose your free gift');
  for (const group of tier.groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'fge-group';
    for (const opt of group.options) {
      const label = document.createElement('label');
      label.className = 'fge-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `fge-tier-${tier.tierId}`;
      radio.value = opt.optionId;
      radio.checked = opt.optionId === tier.selected;
      radio.disabled = !opt.available;
      radio.addEventListener('change', () => handlers.onChoose(tier.tierId, opt.optionId));
      if (!opt.available) {
        label.classList.add('is-unavailable');
      }
      const text = opt.available ? opt.variantLabel : `${opt.variantLabel} — currently unavailable`;
      label.append(radio, document.createTextNode(` ${text}`));
      groupEl.append(label);
    }
    fieldset.append(groupEl);
  }
  return fieldset;
}

// AND: a bundled display of every gift (no radios, no selection). Both are granted by the backend.
function renderAndTier(tier: ChooserAndTier): HTMLElement {
  const fieldset = tierFieldset(tier, 'Your free gift');
  const list = document.createElement('div');
  list.className = 'fge-bundle';
  const intro = document.createElement('span');
  intro.className = 'fge-bundle-intro';
  intro.textContent = tier.items.length > 1 ? 'Get all: ' : 'Get: ';
  list.append(intro);
  tier.items.forEach((item: GiftItemView, i) => {
    if (i > 0) {
      list.append(document.createTextNode(' + '));
    }
    const span = document.createElement('span');
    span.className = 'fge-bundle-item';
    if (!item.available) span.classList.add('is-unavailable');
    span.textContent = item.available ? item.variantLabel : `${item.variantLabel} (unavailable)`;
    list.append(span);
  });
  fieldset.append(list);
  // Surface a partial bundle: an AND gift must be delivered in full, so if any item is unavailable
  // the shopper is told it can't be fully added rather than silently getting one of two.
  if (tier.incomplete) {
    const note = document.createElement('p');
    note.className = 'fge-note fge-note--unavailable';
    note.textContent = 'This gift can’t be fully added right now — please check back.';
    fieldset.append(note);
  }
  return fieldset;
}

// Currency-correct display: Intl knows each currency's fraction digits (2 for USD, 0 for JPY/KRW),
// so minor units divide by 10^digits. Falls back to a raw render if the currency is unknown.
function formatMoney(m: Money): string {
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(m.amountMinor / 10 ** digits);
  } catch {
    return `${m.amountMinor} ${m.currency}`;
  }
}
