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

// Visual horizontal "trail" stepper: track + filled portion (server subtotal) + a node per tier at
// its threshold; the current (highest reached) tier is marked. Authoritative-only — the fill reflects
// the confirmed subtotal, never an optimistic guess. Highest-tier-only is stated in the subnote.
export function renderProgress(mount: HTMLElement, model: ProgressModel | null): void {
  mount.textContent = '';
  if (model === null) {
    return;
  }

  const eyebrow = document.createElement('p');
  eyebrow.className = 'fge-eyebrow';
  eyebrow.textContent = 'Free gift';
  mount.append(eyebrow);

  const headline = document.createElement('p');
  headline.className = 'fge-headline';
  if (model.allUnlocked) {
    headline.textContent = 'You’ve unlocked your free gift';
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

  // Node positions are threshold / topThreshold; the fill is subtotal / topThreshold (0 when unknown).
  const top = Math.max(...model.tiers.map((t) => t.threshold.amountMinor), 1);
  const ratio =
    model.subtotal === null ? 0 : Math.max(0, Math.min(1, model.subtotal.amountMinor / top));

  const stepper = document.createElement('div');
  stepper.className = 'fge-stepper';
  const track = document.createElement('div');
  track.className = 'fge-stepper__track';
  const fill = document.createElement('div');
  fill.className = 'fge-stepper__fill';
  fill.style.width = `${ratio * 100}%`;
  stepper.append(track, fill);
  for (const tier of model.tiers) {
    const step = document.createElement('div');
    step.className = 'fge-step';
    if (tier.reached) step.classList.add('is-reached');
    if (tier.isCurrent) step.classList.add('is-current');
    step.style.left = `${(tier.threshold.amountMinor / top) * 100}%`;
    const dot = document.createElement('div');
    dot.className = 'fge-step__dot';
    const label = document.createElement('div');
    label.className = 'fge-step__label';
    label.textContent = fmt(tier.threshold, true);
    step.append(dot, label);
    stepper.append(step);
  }
  mount.append(stepper);

  const subnote = document.createElement('p');
  subnote.className = 'fge-subnote';
  subnote.textContent = 'You receive the gift for your highest unlocked tier — not one per step.';
  mount.append(subnote);
}
