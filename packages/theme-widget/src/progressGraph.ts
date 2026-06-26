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

// Currency-correct display (Intl knows each currency's fraction digits; minor units / 10^digits).
function fmt(m: Money): string {
  try {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(m.amountMinor / 10 ** digits);
  } catch {
    return `${m.amountMinor} ${m.currency}`;
  }
}

export function renderProgress(mount: HTMLElement, model: ProgressModel | null): void {
  mount.textContent = '';
  if (model === null) {
    return;
  }
  const root = document.createElement('div');
  root.className = 'fge-progress';

  // Headline: "Spend $X more to unlock <gift>" (server subtotal known) / "Spend $threshold to unlock"
  // (subtotal not yet confirmed) / "All gifts unlocked" when everything is reached.
  const headline = document.createElement('p');
  headline.className = 'fge-progress__headline';
  if (model.allUnlocked) {
    headline.textContent = 'You’ve unlocked your free gift';
  } else if (model.next !== null) {
    headline.textContent =
      model.next.spendMore !== null
        ? `Spend ${fmt(model.next.spendMore)} more to unlock ${model.next.giftLabel}`
        : `Spend ${fmt(model.next.threshold)} to unlock ${model.next.giftLabel}`;
  }
  root.append(headline);

  const ladder = document.createElement('ol');
  ladder.className = 'fge-progress__ladder';
  for (const tier of model.tiers) {
    const li = document.createElement('li');
    li.className = 'fge-progress__tier';
    li.dataset['tierId'] = tier.tierId;
    if (tier.reached) li.classList.add('is-reached');
    if (tier.isCurrent) li.classList.add('is-current');
    const state = tier.isCurrent ? '✓ unlocked' : tier.reached ? '✓' : '🔒';
    li.textContent = `${state} ${fmt(tier.threshold)} — ${tier.giftLabel}`;
    ladder.append(li);
  }
  root.append(ladder);
  mount.append(root);
}
