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
  GiftOptionView,
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

// Render the "Your free gift" panel for the CURRENT (highest reached) tier only — the gift the shopper
// actually receives. Showing one tier's gift (never all three as selectable) is what makes
// highest-tier-only unambiguous; the stepper above gives the ladder context. When no tier is reached
// yet, a short prompt is shown (the stepper carries the "spend X more" figure).
export function renderChooser(
  mount: HTMLElement,
  config: CampaignConfigResponse,
  state: ChooserState,
  handlers: ChooserHandlers,
  currentTierId: string | null,
  pending = false,
): void {
  mount.textContent = '';
  const model = buildChooserModel(config, state);
  if (model === null) {
    return;
  }
  const root = document.createElement('div');
  root.className = 'fge-gift';

  // Pending (a gift reconcile is in progress): dim the cards/chips (CSS .is-pending) and show a small
  // spinner next to the heading, so the current selection reads as "in progress", not final. No text
  // line in the body — the message lives on the Checkout button. Authoritative: only a work-in-progress
  // signal; the real gift state still comes from the confirmed cart/validate.
  if (pending) {
    root.classList.add('is-pending');
    root.setAttribute('aria-busy', 'true'); // AT: this region is updating (paired with the live region)
  }

  renderGiftSection(root, model, currentTierId, handlers);

  if (pending) {
    // Spinner beside whatever heading is shown — the "Your free gift" / "Choose your free gift" title
    // when a gift is offered, else the prompt/decline hint (so the spinner ALWAYS shows during pending,
    // not only when a tier is reached).
    const heading = root.querySelector('.fge-gift__title, .fge-gift__hint');
    heading?.append(spinner());
  }

  // The decline checkbox is PERSISTENT: it renders in EVERY state (declined, below-threshold, or a
  // gift shown) so the shopper can always re-add a gift they removed. Only the gift section above
  // reflects cart state — never the checkbox.
  if (model.declineEnabled) {
    root.append(renderDecline(model.declined, handlers));
  }
  mount.append(root);
}

// A small neutral loading spinner (CSS-animated) for the chooser heading during pending.
function spinner(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'fge-spinner';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

// The state-reflecting gift section (above the persistent decline checkbox).
function renderGiftSection(
  root: HTMLElement,
  model: ChooserModel,
  currentTierId: string | null,
  handlers: ChooserHandlers,
): void {
  if (model.declined) {
    root.append(
      hint('Your free gift is removed. Re-check “Add my free gift” below to add it back.'),
    );
    return;
  }
  const current =
    currentTierId === null ? null : model.tiers.find((t) => t.tierId === currentTierId);
  if (current === undefined || current === null) {
    root.append(hint('Add a little more to your cart to unlock your free gift.'));
    return;
  }

  const title = document.createElement('p');
  title.className = 'fge-gift__title';
  title.textContent = current.kind === 'or' ? 'Choose your free gift' : 'Your free gift';
  root.append(title);

  if (current.kind === 'or') {
    // ONE card per PRODUCT (radios). Group them so AT announces "Choose your free gift, radio group".
    const group = document.createElement('div');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Choose your free gift');
    for (const g of current.groups) {
      group.append(renderProductGroup(current.tierId, g, current.selected, handlers));
    }
    root.append(group);
  } else {
    root.append(renderBundle(current));
  }
}

function hint(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'fge-gift__hint';
  p.textContent = text;
  return p;
}

// An <img> for the gift, or an empty placeholder box (CSS background) when there's no image. DECORATIVE
// for AT: the product/variant name is already in the card text, so alt is empty + aria-hidden (avoids
// the screen reader announcing the name twice).
function giftImage(imageUrl: string | null | undefined): HTMLElement {
  if (imageUrl !== null && imageUrl !== undefined && imageUrl.length > 0) {
    const img = document.createElement('img');
    img.className = 'fge-card__img';
    img.src = imageUrl;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    return img;
  }
  const ph = document.createElement('div');
  ph.className = 'fge-card__img';
  ph.setAttribute('aria-hidden', 'true');
  return ph;
}

// One PRODUCT as a card. A single-variant product is a plain card (no chips). A multi-variant product
// (Ice/Dawn, S/M/L) is ONE card whose TITLE is the PRODUCT name; selecting it picks a default variant,
// and a row of variant chips INSIDE the card body (under the title) switches between siblings (OOS
// variants disabled). The chosen variant flows into `choices` as that variant's optionId — identical
// wiring to single options. The chips are <button>s: as interactive content inside the <label>, the
// HTML spec says a click on them does NOT toggle the product radio, so they switch variant cleanly.
function renderProductGroup(
  tierId: string,
  group: GiftProductGroup,
  selectedOptionId: string | undefined,
  handlers: ChooserHandlers,
): HTMLElement {
  const options = group.options;
  if (options.length <= 1) {
    const opt = options[0]!;
    return renderOptionCard(tierId, opt, opt.optionId === selectedOptionId, handlers);
  }

  // Title is the PRODUCT name (variantLabel is the per-variant value chosen via the chips, not a title).
  const productLabel = options[0]?.productLabel ?? options[0]?.variantLabel ?? '';
  const selectedOpt = options.find((o) => o.optionId === selectedOptionId);
  const productSelected = selectedOpt !== undefined;
  const anyAvailable = options.some((o) => o.available);
  // Selecting the product defaults to the currently-chosen variant, else the first available one.
  const defaultPick = selectedOpt ?? options.find((o) => o.available) ?? options[0]!;

  const card = document.createElement('label');
  card.className = 'fge-card';
  if (productSelected) card.classList.add('is-selected');
  if (!anyAvailable) card.classList.add('is-unavailable');

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.className = 'fge-card__radio';
  radio.name = `fge-tier-${tierId}`;
  radio.value = defaultPick.optionId;
  radio.checked = productSelected;
  radio.disabled = !anyAvailable;
  // Clean accessible name = the product name. Without it the label-text name would also absorb the
  // variant chips' button text ("Ice Dawn"). The chips are separately navigable buttons.
  radio.setAttribute('aria-label', productLabel);
  radio.addEventListener('change', () => handlers.onChoose(tierId, defaultPick.optionId));

  const body = document.createElement('div');
  body.className = 'fge-card__body';
  const name = document.createElement('div');
  name.className = 'fge-card__name';
  name.textContent = productLabel;
  body.append(name);

  if (!anyAvailable) {
    const status = document.createElement('div');
    status.className = 'fge-card__status is-unavailable';
    status.textContent = 'Currently unavailable';
    body.append(status);
  } else if (productSelected) {
    // Chips INSIDE the body, directly under the title (visible when this product is the selected radio).
    body.append(renderVariantChips(tierId, options, selectedOptionId, productLabel, handlers));
  } else {
    const status = document.createElement('div');
    status.className = 'fge-card__status';
    status.textContent = `Choose this gift · ${options.length} options`;
    body.append(status);
  }

  card.append(radio, giftImage((selectedOpt ?? defaultPick).imageUrl), body);
  return card;
}

// The row of small variant pills (S / M / L) inside a selected product card.
function renderVariantChips(
  tierId: string,
  options: readonly GiftOptionView[],
  selectedOptionId: string | undefined,
  productLabel: string,
  handlers: ChooserHandlers,
): HTMLElement {
  const picker = document.createElement('div');
  picker.className = 'fge-variants';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', `Choose a ${productLabel} option`);
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fge-variant';
    btn.textContent = opt.variantLabel;
    const isSel = opt.optionId === selectedOptionId;
    if (isSel) btn.classList.add('is-selected');
    btn.setAttribute('aria-pressed', String(isSel));
    if (!opt.available) {
      btn.disabled = true; // removed from the tab order + announced as unavailable
      btn.classList.add('is-unavailable');
      btn.setAttribute('aria-label', `${opt.variantLabel} (currently unavailable)`);
    } else {
      btn.addEventListener('click', () => handlers.onChoose(tierId, opt.optionId));
    }
    picker.append(btn);
  }
  return picker;
}

// One selectable OR option as a card row: image + name + status, with a radio (auto-add on change).
function renderOptionCard(
  tierId: string,
  opt: GiftOptionView,
  selected: boolean,
  handlers: ChooserHandlers,
): HTMLElement {
  const available = opt.available;
  const card = document.createElement('label');
  card.className = 'fge-card';
  if (selected) card.classList.add('is-selected');
  if (!available) card.classList.add('is-unavailable');

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.className = 'fge-card__radio';
  radio.name = `fge-tier-${tierId}`;
  radio.value = opt.optionId;
  radio.checked = selected;
  radio.disabled = !available;
  radio.addEventListener('change', () => handlers.onChoose(tierId, opt.optionId));

  const body = document.createElement('div');
  body.className = 'fge-card__body';
  const name = document.createElement('div');
  name.className = 'fge-card__name';
  name.textContent = opt.variantLabel;
  const status = document.createElement('div');
  status.className = 'fge-card__status';
  if (!available) {
    status.classList.add('is-unavailable');
    status.textContent = 'Currently unavailable';
  } else if (selected) {
    status.classList.add('is-unlocked');
    status.textContent = 'Unlocked · added free';
  } else {
    status.textContent = 'Choose this gift';
  }
  body.append(name, status);

  card.append(radio, giftImage(opt.imageUrl), body);
  return card;
}

// AND: every gift shown as an image card (no radios — both are granted together). Incomplete note when
// a bundle item is unavailable (can't be fully added).
function renderBundle(tier: ChooserAndTier): HTMLElement {
  const wrap = document.createElement('div');
  for (const item of tier.items) {
    const card = document.createElement('div');
    card.className = 'fge-card';
    if (!item.available) card.classList.add('is-unavailable');
    const body = document.createElement('div');
    body.className = 'fge-card__body';
    const name = document.createElement('div');
    name.className = 'fge-card__name';
    name.textContent = item.variantLabel;
    const status = document.createElement('div');
    status.className = 'fge-card__status';
    if (item.available) {
      status.classList.add('is-unlocked');
      status.textContent = 'Unlocked · added free';
    } else {
      status.classList.add('is-unavailable');
      status.textContent = 'Currently unavailable';
    }
    body.append(name, status);
    card.append(giftImage(item.imageUrl), body);
    wrap.append(card);
  }
  if (tier.incomplete) {
    const note = document.createElement('p');
    note.className = 'fge-note--unavailable';
    note.textContent = 'This gift can’t be fully added right now — please check back.';
    wrap.append(note);
  }
  return wrap;
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
