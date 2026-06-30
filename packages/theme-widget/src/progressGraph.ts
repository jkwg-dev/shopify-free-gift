// Tier progress graph (Phase 5b-2b-1). The render DECISION is a pure, unit-tested view-model
// (buildProgressModel); renderProgress just paints it. AUTHORITATIVE ONLY: the ladder + thresholds
// come from /config (the enforced presentment figures), and "reached"/current/subtotal come ONLY
// from the last /validate result. No optimistic movement, no client estimate — when the server has
// not confirmed a subtotal (no-gift), we show the next tier's absolute threshold, not a guessed delta.
import {
  money,
  type CampaignConfigResponse,
  type Money,
  type ValidateResult,
} from '@free-gift-engine/core';

export type ProgressTierView = {
  readonly tierId: string;
  readonly position: number;
  readonly threshold: Money; // presentment (== /validate appliedThreshold)
  readonly giftLabel: string;
  readonly reached: boolean; // server-confirmed (subtotal >= threshold); false when subtotal unknown
  readonly isCurrent: boolean; // the resolved winning tier from /validate
};

export type ProgressNext = {
  readonly tierId: string;
  readonly threshold: Money;
  readonly giftLabel: string;
  // How much more to spend to reach this tier, or null when the server hasn't confirmed a subtotal
  // (e.g. below tier 1 / no-gift) — the DOM then shows the absolute threshold, never a guess.
  readonly spendMore: Money | null;
};

export type ProgressModel = {
  readonly currency: string;
  readonly subtotal: Money | null; // server-authoritative qualifying subtotal, or null
  readonly tiers: readonly ProgressTierView[];
  readonly next: ProgressNext | null; // lowest unreached tier, or null when all reached
  readonly allUnlocked: boolean;
  // True until /validate confirms a result (no result yet). While pending we show a NEUTRAL headline,
  // never a specific lower tier — otherwise a cart that already qualifies for tier 2/3 flashes "Reach
  // CA$500" on open before the server resolves. Distinct from a confirmed below-tier-1 (lastResult set).
  readonly pending: boolean;
};

type ActiveConfig = Extract<CampaignConfigResponse, { status: 'active' }>;
type ActiveTier = ActiveConfig['tiers'][number];

// Product name for a gift item. Prefers `productLabel` (the owning product's title) over
// `variantLabel` (the variant option value like "Ice"/"Dawn"/"S"/"M"/"L").
function productName(g: { readonly productLabel?: string; readonly variantLabel: string }): string {
  return g.productLabel !== undefined && g.productLabel !== '' ? g.productLabel : g.variantLabel;
}

// Concise gift label for the ladder using PRODUCT names (not variant/color names). AND → distinct
// product titles joined; OR → product titles (few) or "Choose 1 of N".
export function giftLabelFor(gift: ActiveTier['gift']): string {
  if (gift.kind === 'AND') {
    const names = [...new Set(gift.gifts.map(productName))];
    return names.join(' + ');
  }
  if (gift.options.length <= 3) {
    const names = [...new Set(gift.options.map(productName))];
    return names.join(' / ');
  }
  return `Choose 1 of ${gift.options.length}`;
}

export function buildProgressModel(
  config: CampaignConfigResponse,
  lastResult: ValidateResult | null,
): ProgressModel | null {
  if (config.status !== 'active') {
    return null;
  }
  // Authoritative subtotal from EITHER arm: the gift arm carries it, and the no-gift arm now carries it
  // too (additive contract change) so the fill shows real progress below tier 1. `?? null` covers the
  // one no-gift case without it ('inactive').
  const subtotal =
    lastResult?.status === 'gift'
      ? lastResult.subtotal
      : lastResult?.status === 'no-gift'
        ? (lastResult.subtotal ?? null)
        : null;
  const currentTierId = lastResult?.status === 'gift' ? lastResult.tierId : null;

  const tiers: ProgressTierView[] = config.tiers.map((tier) => ({
    tierId: tier.tierId,
    position: tier.position,
    threshold: tier.threshold,
    giftLabel: giftLabelFor(tier.gift),
    reached: subtotal !== null && subtotal.amountMinor >= tier.threshold.amountMinor,
    isCurrent: tier.tierId === currentTierId,
  }));

  // Next = the lowest-threshold tier not yet reached (ascending by threshold).
  const ascending = [...tiers].sort((a, b) => a.threshold.amountMinor - b.threshold.amountMinor);
  const nextTier = ascending.find((t) => !t.reached) ?? null;
  // spendMore (the "Spend CA$X more" delta) only once at least one tier is unlocked; below tier 1 the
  // headline stays the absolute "Reach CA$500" goal even though the subtotal is now known (it just
  // feeds the fill). This keeps the headline copy unchanged while fixing the fill.
  const anyReached = tiers.some((t) => t.reached);
  const next: ProgressNext | null =
    nextTier === null
      ? null
      : {
          tierId: nextTier.tierId,
          threshold: nextTier.threshold,
          giftLabel: nextTier.giftLabel,
          spendMore:
            subtotal === null || !anyReached
              ? null
              : money(
                  Math.max(0, nextTier.threshold.amountMinor - subtotal.amountMinor),
                  config.currency,
                ),
        };

  return {
    currency: config.currency,
    subtotal,
    tiers,
    next,
    allUnlocked: next === null && tiers.length > 0,
    pending: lastResult === null, // no server result yet → neutral headline (see ProgressModel)
  };
}

// --- DOM rendering (manual-tested) ---------------------------------------------------------------

const major = (m: Money): number => {
  try {
    const digits =
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: m.currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
    return m.amountMinor / 10 ** digits;
  } catch {
    return m.amountMinor / 100;
  }
};
// Currency-correct display; `compact` drops the fraction (tidy stepper node labels).
function fmt(m: Money, compact = false): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: m.currency,
      ...(compact ? { maximumFractionDigits: 0 } : {}),
    }).format(major(m));
  } catch {
    return `${m.amountMinor} ${m.currency}`;
  }
}

export type StepAlign = 'start' | 'center' | 'end';
export type StepNode = {
  readonly tierId: string;
  readonly posPct: number; // node position along the track (threshold / auto-computed fill max)
  readonly align: StepAlign; // label alignment so edge labels don't clip off the track
  readonly reached: boolean;
  readonly isCurrent: boolean;
};

// The stepper auto-scales: the fill track runs 0 -> (highest tier threshold x STEPPER_HEADROOM), so the
// top tier always lands at ~75% with ~25% headroom regardless of the tier AMOUNTS — no hardcoded cap.
// 4/3 = 1.33...: highest / (highest x 4/3) = 0.75 exactly. The fill model is unchanged from 5b-2b
// (LINEAR, absolute-amount proportional, 0 = unknown subtotal); only the max is now derived.
export const STEPPER_HEADROOM = 4 / 3;
// Degenerate guard (no tiers, or a zero highest threshold) → avoid divide-by-zero. The stepper has
// nothing meaningful to show in that case anyway.
const STEPPER_FALLBACK_MAX = 1;

// Pure stepper geometry (unit-tested). The track max = highest tier threshold x STEPPER_HEADROOM; fill %
// and each node sit at amount/max (clamped 0–100). The fill is the confirmed subtotal on that scale
// (0 when unknown — never optimistic); nodes sit at their thresholds (evenly-spaced tiers -> 25/50/75%),
// leaving ~25% headroom past the top. A node reads filled when the fill reaches it (fill% >= its
// position% iff subtotal >= threshold, exactly `reached`). Labels align start/center/end so an edge
// label can't clip off the track.
export function stepperLayout(model: ProgressModel): { fillPct: number; nodes: StepNode[] } {
  const ordered = [...model.tiers].sort(
    (a, b) => a.threshold.amountMinor - b.threshold.amountMinor,
  );
  const highest = ordered[ordered.length - 1]?.threshold;
  const fillMax =
    highest !== undefined && major(highest) > 0
      ? major(highest) * STEPPER_HEADROOM
      : STEPPER_FALLBACK_MAX;
  const pct = (m: Money): number => Math.max(0, Math.min(100, (major(m) / fillMax) * 100));
  const fillPct = model.subtotal === null ? 0 : pct(model.subtotal);
  const nodes = ordered.map((t): StepNode => {
    const posPct = pct(t.threshold);
    const align: StepAlign = posPct <= 8 ? 'start' : posPct >= 92 ? 'end' : 'center';
    return { tierId: t.tierId, posPct, align, reached: t.reached, isCurrent: t.isCurrent };
  });
  return { fillPct, nodes };
}

type StepperUi = {
  readonly headline: HTMLElement;
  readonly fill: HTMLElement;
  readonly steps: Map<string, { el: HTMLElement; label: HTMLElement }>;
};

// Build the stepper skeleton ONCE into `mount` and reuse it across renders — so the fill width changes
// from its PREVIOUS value (CSS transition animates) instead of being recreated at the target each time.
// Rebuilds only if the tier set changes (campaign swap), detected via a data-key. Returns live refs.
function ensureSkeleton(mount: HTMLElement, nodes: readonly StepNode[]): StepperUi {
  const key = nodes.map((n) => n.tierId).join('|');
  const existing = mount.querySelector<HTMLElement>('.fge-stepper');
  if (existing !== null && mount.dataset['fgeTiers'] === key) {
    const steps = new Map<string, { el: HTMLElement; label: HTMLElement }>();
    for (const el of existing.querySelectorAll<HTMLElement>('.fge-step')) {
      steps.set(el.dataset['tier'] ?? '', {
        el,
        label: el.querySelector<HTMLElement>('.fge-step__label')!,
      });
    }
    return {
      headline: mount.querySelector<HTMLElement>('.fge-headline')!,
      fill: existing.querySelector<HTMLElement>('.fge-stepper__fill')!,
      steps,
    };
  }

  mount.textContent = '';
  const headline = document.createElement('p');
  headline.className = 'fge-headline';
  const stepper = document.createElement('div');
  stepper.className = 'fge-stepper';
  // The bar/nodes/labels are a DECORATIVE visualization of the headline + subnote text; hide them from
  // AT so it doesn't read "CA$500 CA$1,000 CA$1,500" as noise. The headline + subnote stay readable.
  stepper.setAttribute('aria-hidden', 'true');
  const track = document.createElement('div');
  track.className = 'fge-stepper__track';
  const fill = document.createElement('div');
  fill.className = 'fge-stepper__fill';
  stepper.append(track, fill);
  const steps = new Map<string, { el: HTMLElement; label: HTMLElement }>();
  for (const node of nodes) {
    const step = document.createElement('div');
    step.className = 'fge-step';
    step.dataset['tier'] = node.tierId;
    step.style.left = `${node.posPct}%`;
    const dot = document.createElement('div');
    dot.className = 'fge-step__dot';
    const label = document.createElement('div');
    label.className = 'fge-step__label';
    step.append(dot, label);
    stepper.append(step);
    steps.set(node.tierId, { el: step, label });
  }
  const subnote = document.createElement('p');
  subnote.className = 'fge-subnote';
  subnote.textContent = 'You receive the gift for your highest unlocked tier — not one per step.';
  const fullPriceNote = document.createElement('p');
  fullPriceNote.className = 'fge-fullprice-note';
  fullPriceNote.textContent =
    'Only full-price & non-promotional items count toward your gift tier.';
  mount.append(headline, stepper, fullPriceNote, subnote);
  mount.dataset['fgeTiers'] = key;
  return { headline, fill, steps };
}

// Paint the headline. PENDING (no server result yet) → neutral, never a specific lower tier, so a cart
// that already qualifies doesn't flash "Reach CA$500" on open. No "cart" word here (the theme's "Your
// cart" header is right above — duplicating it reads as two headers).
function setHeadline(headline: HTMLElement, model: ProgressModel): void {
  headline.textContent = '';
  if (model.pending) {
    headline.textContent = 'Loading your free gift…';
    return;
  }
  if (model.allUnlocked) {
    headline.textContent = 'You’ve unlocked your free gift';
    return;
  }
  if (model.next === null) {
    return;
  }
  const amt = document.createElement('span');
  amt.className = 'fge-amt';
  amt.textContent = fmt(model.next.spendMore ?? model.next.threshold);
  const spend = model.next.spendMore !== null;
  headline.append(
    document.createTextNode(spend ? 'Spend ' : 'Reach '),
    amt,
    document.createTextNode(
      spend ? ` more to unlock ${model.next.giftLabel}` : ` to unlock ${model.next.giftLabel}`,
    ),
  );
}

// Visual horizontal "trail" stepper: track + filled portion (server subtotal) + a node per tier; the
// current (highest reached) tier is marked. Authoritative-only — the fill reflects the confirmed
// subtotal, never an optimistic guess. The skeleton persists across renders so the fill ANIMATES to
// the new value (CSS transition) rather than snapping. Highest-tier-only is stated in the subnote.
export function renderProgress(mount: HTMLElement, model: ProgressModel | null): void {
  if (model === null) {
    mount.textContent = '';
    delete mount.dataset['fgeTiers'];
    return;
  }
  const { fillPct, nodes } = stepperLayout(model);
  const byTier = new Map(model.tiers.map((t) => [t.tierId, t]));
  const ui = ensureSkeleton(mount, nodes);

  setHeadline(ui.headline, model);
  ui.fill.style.width = `${fillPct}%`; // CSS transitions width → animates to the confirmed value

  for (const node of nodes) {
    const step = ui.steps.get(node.tierId);
    if (step === undefined) {
      continue;
    }
    step.el.className =
      `fge-step fge-step--${node.align}` +
      (node.reached ? ' is-reached' : '') +
      (node.isCurrent ? ' is-current' : '');
    step.el.style.left = `${node.posPct}%`;
    step.label.textContent = fmt(byTier.get(node.tierId)!.threshold, true);
  }
}
