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
};

type ActiveConfig = Extract<CampaignConfigResponse, { status: 'active' }>;
type ActiveTier = ActiveConfig['tiers'][number];

// Concise gift label for the ladder. AND → all variants joined; OR → the labels (few) or "Choose 1 of N".
export function giftLabelFor(gift: ActiveTier['gift']): string {
  if (gift.kind === 'AND') {
    return gift.gifts.map((g) => g.variantLabel).join(' + ');
  }
  if (gift.options.length <= 3) {
    return gift.options.map((o) => o.variantLabel).join(' / ');
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
  const subtotal = lastResult?.status === 'gift' ? lastResult.subtotal : null;
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
  const next: ProgressNext | null =
    nextTier === null
      ? null
      : {
          tierId: nextTier.tierId,
          threshold: nextTier.threshold,
          giftLabel: nextTier.giftLabel,
          spendMore:
            subtotal === null
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
  readonly posPct: number; // node position along the track (threshold / top threshold)
  readonly align: StepAlign; // label alignment so edge labels don't clip off the track
  readonly reached: boolean;
  readonly isCurrent: boolean;
};

// Pure stepper geometry (unit-tested). fillPct = confirmed subtotal / top threshold (0 when unknown —
// never optimistic). Each node sits at threshold/top; its label aligns start/center/end so the first
// and last labels stay inside the track instead of overflowing the drawer edge (the clipping bug).
export function stepperLayout(model: ProgressModel): { fillPct: number; nodes: StepNode[] } {
  const top = Math.max(...model.tiers.map((t) => t.threshold.amountMinor), 1);
  const fillPct =
    model.subtotal === null
      ? 0
      : Math.max(0, Math.min(100, (model.subtotal.amountMinor / top) * 100));
  const nodes = model.tiers.map((t): StepNode => {
    const posPct = (t.threshold.amountMinor / top) * 100;
    const align: StepAlign = posPct <= 8 ? 'start' : posPct >= 92 ? 'end' : 'center';
    return { tierId: t.tierId, posPct, align, reached: t.reached, isCurrent: t.isCurrent };
  });
  return { fillPct, nodes };
}

// Visual horizontal "trail" stepper: track + filled portion (server subtotal) + a node per tier at
// its threshold; the current (highest reached) tier is marked. Authoritative-only — the fill reflects
// the confirmed subtotal, never an optimistic guess. Highest-tier-only is stated in the subnote.
export function renderProgress(mount: HTMLElement, model: ProgressModel | null): void {
  mount.textContent = '';
  if (model === null) {
    return;
  }

  // Compact single line (no eyebrow, no big headline) so it blends UNDER the theme's "Your cart"
  // header as a slim progress row rather than competing with it.
  const headline = document.createElement('p');
  headline.className = 'fge-headline';
  if (model.allUnlocked) {
    headline.textContent = 'Free gift unlocked';
  } else if (model.next !== null) {
    const amt = document.createElement('span');
    amt.className = 'fge-amt';
    amt.textContent = fmt(model.next.spendMore ?? model.next.threshold);
    const verb = model.next.spendMore !== null ? 'Spend ' : 'Reach ';
    const tail =
      model.next.spendMore !== null
        ? ` more to unlock ${model.next.giftLabel}`
        : ` to unlock ${model.next.giftLabel}`;
    headline.append(document.createTextNode(verb), amt, document.createTextNode(tail));
  }
  mount.append(headline);

  const { fillPct, nodes } = stepperLayout(model);
  const byTier = new Map(model.tiers.map((t) => [t.tierId, t]));

  const stepper = document.createElement('div');
  stepper.className = 'fge-stepper';
  const track = document.createElement('div');
  track.className = 'fge-stepper__track';
  const fill = document.createElement('div');
  fill.className = 'fge-stepper__fill';
  fill.style.width = `${fillPct}%`;
  stepper.append(track, fill);
  for (const node of nodes) {
    const step = document.createElement('div');
    step.className = `fge-step fge-step--${node.align}`;
    if (node.reached) step.classList.add('is-reached');
    if (node.isCurrent) step.classList.add('is-current');
    step.style.left = `${node.posPct}%`;
    const dot = document.createElement('div');
    dot.className = 'fge-step__dot';
    const label = document.createElement('div');
    label.className = 'fge-step__label';
    label.textContent = fmt(byTier.get(node.tierId)!.threshold, true);
    step.append(dot, label);
    stepper.append(step);
  }
  mount.append(stepper);

  const subnote = document.createElement('p');
  subnote.className = 'fge-subnote';
  subnote.textContent = 'You receive the gift for your highest unlocked tier — not one per step.';
  mount.append(subnote);
}
