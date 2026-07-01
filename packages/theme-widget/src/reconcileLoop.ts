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
import { fgeLog } from './debug.js';

export type GiftCartIo = {
  // Read the live cart as reconciler lines + presentment currency.
  readCart: () => Promise<{ lines: readonly CartLineView[]; currency: string }>;
  // Server-authoritative resolution for a cart snapshot; null = error (leave the cart untouched).
  validate: (lines: readonly CartLineView[], currency: string) => Promise<ValidateResult | null>;
  // Cart writer for applyCartPlan (cart/add.js, cart/change.js).
  post: CartPost;
  // Apply (code) or clear (null) the discount via the Cart AJAX API. Returns whether the write
  // SUCCEEDED — a concurrent Dawn cart/change.js can 422 our cart/update.js (the AJAX cart serializes
  // writes), and a swallowed failure would leave the gift code detached. The loop retries on false.
  setDiscount: (code: string | null) => Promise<boolean>;
  // Optional theme re-render nudge after a mutating pass.
  nudge?: () => void;
};

export type ReconcileOutcome = {
  readonly passes: number;
  readonly converged: boolean;
  readonly appliedCode: string | null;
  readonly failures: readonly CartMutationFailure[];
  // True when this run issued any cart AJAX write (gift add/remove/adjust or discount apply/clear).
  // Dawn does not re-render line-item keys after our raw cart/update.js, so the storefront must
  // section-refresh the items body whenever this is set — otherwise qty steppers keep stale keys.
  readonly wroteCart: boolean;
  // True when this run added/removed/adjusted a GIFT LINE (line membership changed) — as opposed to
  // only applying/clearing a discount code, which does NOT change line keys. The storefront forces a
  // body re-fetch only on this signal, so a code-only write never wipes Dawn's optimistic +/- value.
  readonly mutatedGiftLines: boolean;
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
  let wroteCart = false;
  let mutatedGiftLines = false;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const { lines, currency } = await io.readCart();
    const result = await io.validate(lines, currency);
    if (result === null) {
      return { passes: pass, converged: false, appliedCode, failures, wroteCart, mutatedGiftLines }; // error: leave cart as-is
    }

    const plan = reconcileGiftLines(lines, result);
    const hasRemoveAdjust = plan.remove.length > 0 || plan.adjust.length > 0;
    let codeNeedsChange = plan.applyCode !== appliedCode;

    fgeLog(`pass ${pass}`, {
      status: result.status,
      reason: 'reason' in result ? result.reason : undefined,
      lines: lines.map((l) => ({
        v: l.variantId,
        qty: l.quantity,
        appAdded: l.appAdded,
        finalLinePrice: l.finalLinePrice,
        hasDiscountAllocation: l.hasDiscountAllocation,
      })),
      plan: {
        add: plan.add.map((a) => a.variantId),
        remove: plan.remove.map((r) => r.variantId),
        adjust: plan.adjust.map((a) => a.variantId),
        applyCode: plan.applyCode,
      },
      appliedCode,
      codeNeedsChange,
    });

    // A gift line that is NOT $0 is always wrong (its code detached). Never converge while one exists,
    // even if reconcileGiftLines plans nothing and the code appears applied — the charged-gift sweep
    // below removes it and the next pass re-adds it WITH the code (the "gift present but not free" bug).
    const hasChargedGift = lines.some((l) => l.appAdded && (l.finalLinePrice ?? 0) > 0);

    // Filter adds BEFORE convergence check (same as before) — but we'll recompute after removes
    // in case `addAttempted` entries are cleared for removed variants.
    let add = plan.add.filter((a) => !addAttempted.has(a.variantId));

    if (!hasRemoveAdjust && add.length === 0 && !codeNeedsChange && !hasChargedGift) {
      return { passes: pass, converged: true, appliedCode, failures, wroteCart, mutatedGiftLines }; // cart already matches
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
      wroteCart = true;
      mutatedGiftLines = true;
      const res = await applyCartPlan({ ...plan, add: [] }, io.post);
      removed.push(...res.removed);
      adjusted.push(...res.adjusted);
      passFailures.push(...res.failures);
      // A successfully removed variant must be re-addable: a charged copy was just cleared, so the
      // re-add (which creates a fresh $0 copy) must not be blocked by the once-per-run guard.
      for (const r of plan.remove) {
        if (removed.includes(r.id)) {
          addAttempted.delete(r.variantId);
        }
      }
      // Recompute adds after clearing — a variant that was blocked is now eligible.
      add = plan.add.filter((a) => !addAttempted.has(a.variantId));
    }
    // Revenue-critical invariant: the scoped gift code MUST be on the cart whenever a gift is granted.
    // Re-apply it any time we are about to (re)add a gift line — even if in-memory `appliedCode`
    // claims it is already applied — so a code that silently dropped (e.g. a prior apply 422'd under
    // cart-write contention, or Shopify cleared it) is always restored before the $0 line lands.
    if (result.status === 'gift' && add.length > 0) {
      codeNeedsChange = true;
    }
    if (codeNeedsChange) {
      wroteCart = true;
      const ok = await io.setDiscount(plan.applyCode);
      fgeLog(`pass ${pass}: setDiscount`, plan.applyCode, 'ok?', ok);
      if (ok) {
        appliedCode = plan.applyCode;
      } else {
        // The apply/clear FAILED — almost always transient AJAX-cart write contention (a concurrent
        // Dawn cart/change.js 422s our cart/update.js). Do NOT mark it applied (leave appliedCode so
        // the retry re-applies) and skip the add this pass — never add a gift we cannot zero. The
        // next pass re-reads and retries; contention has cleared by then. This is what stops the
        // "code doesn't attach until I edit again" failure: we self-heal inside the same run.
        io.nudge?.();
        continue;
      }
    }
    if (add.length > 0) {
      wroteCart = true;
      mutatedGiftLines = true;
      for (const a of add) {
        addAttempted.add(a.variantId); // add this variant at most once per run (no re-add churn)
      }
      const res = await applyCartPlan({ ...plan, remove: [], adjust: [], add }, io.post);
      added.push(...res.added);
      passFailures.push(...res.failures);
      // Shopify can merge/split the just-added gift without leaving a settled $0 app-added line
      // (Model C / issue #6). If the HTTP add succeeded but the marker still isn't a free gift line,
      // drop the once-per-run guard so the next pass can retry instead of converging stuck at full price.
      if (res.added.length > 0) {
        const verify = await io.readCart();
        for (const variantId of res.added) {
          const settledGift = verify.lines.some(
            (l) => l.variantId === variantId && l.appAdded && (l.finalLinePrice ?? 0) === 0,
          );
          if (!settledGift) {
            addAttempted.delete(variantId);
          }
        }
      }
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
      // Hard invariant: no _fge_gift line may remain with finalLinePrice > 0 in the settled cart.
      // Re-read and sweep before converging — if any charged gift survives (e.g. discount hasn't
      // settled), remove it and fall through to re-validate on the next pass.
      const postCart = await io.readCart();
      const charged = postCart.lines.filter((l) => l.appAdded && (l.finalLinePrice ?? 0) > 0);
      if (charged.length > 0) {
        fgeLog(`pass ${pass}: charged-gift sweep (removing full-price gift lines)`, {
          charged: charged.map((l) => ({ v: l.variantId, finalLinePrice: l.finalLinePrice })),
        });
        const updates: Record<string, number> = {};
        for (const l of charged) updates[l.id] = 0;
        wroteCart = true;
        mutatedGiftLines = true;
        await io.post('cart/update.js', { updates });
        for (const l of charged) addAttempted.delete(l.variantId);
        continue; // re-validate on next pass
      }
      return { passes: pass, converged: true, appliedCode, failures, wroteCart, mutatedGiftLines };
    }
  }

  return {
    passes: maxPasses,
    converged: false,
    appliedCode,
    failures,
    wroteCart,
    mutatedGiftLines,
  };
}
