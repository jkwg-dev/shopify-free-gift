// Convergent gift-cart reconcile (Phase 5b-2a fix for rapid-add / tier-cross races). reconcileGiftLines
// (core, pure) computes the normalization for ONE cart snapshot; this loop drives it to CONVERGENCE
// against the LIVE cart: read -> validate -> apply, repeating until the cart already matches (empty plan
// + code unchanged) or a pass cap. Re-validating each pass means the desired set always reflects the
// TRUE current subtotal/tier — so a gift added mid-burst isn't re-added, a previous tier's gift is
// removed (highest-tier-only), and a bumped quantity is collapsed, even when rapid user adds and our
// own writes interleave.
//
// Round-trip reduction (step 3a): when an apply FULLY realizes the plan (reconcileSettled — every
// planned remove/adjust/add succeeded, no failures), we converge WITHOUT the confirming extra /cart.js
// re-read + /validate. That's safe because our mutations only touch GIFT lines, never the qualifying
// lines — so the tier /validate computed this pass is invariant under them. A partial/failed apply
// still falls through to a real re-read + re-validate pass (the race/422 path is never skipped).
//
// Safety: a gift variant that FAILS to add (e.g. 422 — unpublished to the Online Store) is recorded
// and NOT retried within this run, so an unaddable gift can never spin the loop. Bounded by maxPasses.
import { reconcileGiftLines, type CartLineView, type ValidateResult } from '@free-gift-engine/core';
import { applyCartPlan, type CartMutationFailure, type CartPost } from './cartMutations.js';

export type GiftCartIo = {
  // Read the live cart as reconciler lines + presentment currency.
  readCart: () => Promise<{ lines: readonly CartLineView[]; currency: string }>;
  // Server-authoritative resolution for a cart snapshot; null = error (leave the cart untouched).
  validate: (lines: readonly CartLineView[], currency: string) => Promise<ValidateResult | null>;
  // Cart writer for applyCartPlan (cart/add.js, cart/change.js).
  post: CartPost;
  // Apply (code) or clear (null) the discount via the Cart AJAX API.
  setDiscount: (code: string | null) => Promise<void>;
  // Optional theme re-render nudge after a mutating pass.
  nudge?: () => void;
};

export type ReconcileOutcome = {
  readonly passes: number;
  readonly converged: boolean;
  readonly appliedCode: string | null;
  readonly failures: readonly CartMutationFailure[];
};

// Pure predicate (unit-tested): did the apply FULLY realize the plan? If every planned remove/adjust/add
// succeeded with zero failures, the cart now holds exactly the desired gifts AND the qualifying (non-gift)
// lines are untouched — so a re-`/validate` would return the SAME tier, making the confirming pass
// redundant. We can converge without the extra /cart.js re-read + /validate round-trip.
//
// SAFETY: this skips the confirming validate ONLY on a clean, complete apply. ANY failure or partial
// apply (a count is off — a 422, a race, a merge/split) returns false, so the loop re-reads and
// re-validates exactly as before. We never skip validation in a way that could leave a wrong gift or a
// leak: correctness over speed on every doubtful path.
export function reconcileSettled(
  expected: { readonly adds: number; readonly removes: number; readonly adjusts: number },
  applied: {
    readonly added: number;
    readonly removed: number;
    readonly adjusted: number;
    readonly failed: number;
  },
): boolean {
  return (
    applied.failed === 0 &&
    applied.added === expected.adds &&
    applied.removed === expected.removes &&
    applied.adjusted === expected.adjusts
  );
}

export async function reconcileGiftCart(
  io: GiftCartIo,
  opts: { readonly maxPasses?: number; readonly initialCode?: string | null } = {},
): Promise<ReconcileOutcome> {
  const maxPasses = opts.maxPasses ?? 4;
  let appliedCode: string | null = opts.initialCode ?? null;
  // Each desired gift variant is ADDED at most once per run. This is what stops the visible churn:
  // if a just-added gift isn't yet reflected in the next pass's read (add-merge lag), we DON'T issue
  // a second add (which Shopify would merge/split into qty 2 then we'd collapse back) — we simply wait
  // for it to appear. Also covers a failed add (e.g. 422): attempted once, not retried -> no flap.
  const addAttempted = new Set<string>();
  const failures: CartMutationFailure[] = [];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const { lines, currency } = await io.readCart();
    const result = await io.validate(lines, currency);
    if (result === null) {
      return { passes: pass, converged: false, appliedCode, failures }; // error: leave cart as-is
    }

    const plan = reconcileGiftLines(lines, result);
    const add = plan.add.filter((a) => !addAttempted.has(a.variantId));
    const hasRemoveAdjust = plan.remove.length > 0 || plan.adjust.length > 0;
    const codeNeedsChange = plan.applyCode !== appliedCode;

    if (!hasRemoveAdjust && add.length === 0 && !codeNeedsChange) {
      return { passes: pass, converged: true, appliedCode, failures }; // cart already matches
    }

    // ORDER (this is what removes the visible FULL-PRICE beat): remove/adjust the OUTGOING gift FIRST,
    // then apply the (new) code, then ADD the new gift LAST — so the incoming gift is zeroed by BXGY
    // the instant it lands (never rendered at full price + no subtotal spike), and the outgoing gift is
    // gone before the code swaps (so it can't briefly lose its discount either). Authoritative-only:
    // BXGY does the zeroing server-side, so we never show a $0 the server hasn't applied, and the
    // code's minimum-purchase condition still gates the discount (no leak). If the add fails, we've
    // merely applied a code with no matching gift (harmless $0 effect) — same end state as before.
    const removed: string[] = [];
    const adjusted: string[] = [];
    const added: string[] = [];
    const passFailures: CartMutationFailure[] = [];
    if (hasRemoveAdjust) {
      const res = await applyCartPlan({ ...plan, add: [] }, io.post);
      removed.push(...res.removed);
      adjusted.push(...res.adjusted);
      passFailures.push(...res.failures);
    }
    if (codeNeedsChange) {
      await io.setDiscount(plan.applyCode);
      appliedCode = plan.applyCode;
    }
    if (add.length > 0) {
      for (const a of add) {
        addAttempted.add(a.variantId); // add this variant at most once per run (no re-add churn)
      }
      const res = await applyCartPlan({ ...plan, remove: [], adjust: [], add }, io.post);
      added.push(...res.added);
      passFailures.push(...res.failures);
    }
    failures.push(...passFailures);
    io.nudge?.();

    // CONVERGE EARLY when the apply fully realized the plan: the desired gifts are now in the cart and
    // the qualifying lines are untouched, so re-validating would return the same tier. This drops the
    // redundant confirming /cart.js re-read AND /validate in the common case. A failure/partial apply
    // (predicate false) falls through to the next pass — re-read + re-validate — preserving convergence.
    const settled = reconcileSettled(
      { adds: add.length, removes: plan.remove.length, adjusts: plan.adjust.length },
      {
        added: added.length,
        removed: removed.length,
        adjusted: adjusted.length,
        failed: passFailures.length,
      },
    );
    if (settled) {
      return { passes: pass, converged: true, appliedCode, failures };
    }
  }

  return { passes: maxPasses, converged: false, appliedCode, failures };
}
