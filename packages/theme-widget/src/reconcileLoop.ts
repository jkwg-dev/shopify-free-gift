// Convergent gift-cart reconcile (Phase 5b-2a fix for rapid-add / tier-cross races). reconcileGiftLines
// (core, pure) computes the normalization for ONE cart snapshot; this loop drives it to CONVERGENCE
// against the LIVE cart: re-read -> re-validate -> apply, repeating until the cart already matches
// (empty plan + code unchanged) or a pass cap. Re-validating each pass means the desired set always
// reflects the TRUE current subtotal/tier — so a gift added mid-burst isn't re-added, a previous
// tier's gift is removed (highest-tier-only), and a bumped quantity is collapsed, even when rapid
// user adds and our own writes interleave.
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

export async function reconcileGiftCart(
  io: GiftCartIo,
  opts: { readonly maxPasses?: number; readonly initialCode?: string | null } = {},
): Promise<ReconcileOutcome> {
  const maxPasses = opts.maxPasses ?? 4;
  let appliedCode: string | null = opts.initialCode ?? null;
  const blockedAdds = new Set<string>(); // variants that failed to add this run — don't retry (no flap)
  const failures: CartMutationFailure[] = [];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const { lines, currency } = await io.readCart();
    const result = await io.validate(lines, currency);
    if (result === null) {
      return { passes: pass, converged: false, appliedCode, failures }; // error: leave cart as-is
    }

    const plan = reconcileGiftLines(lines, result);
    const add = plan.add.filter((a) => !blockedAdds.has(a.variantId));
    const cartNeedsChange = add.length > 0 || plan.remove.length > 0 || plan.adjust.length > 0;
    const codeNeedsChange = plan.applyCode !== appliedCode;

    if (!cartNeedsChange && !codeNeedsChange) {
      return { passes: pass, converged: true, appliedCode, failures }; // cart already matches
    }

    if (cartNeedsChange) {
      const res = await applyCartPlan({ ...plan, add }, io.post);
      for (const f of res.failures) {
        failures.push(f);
        if (f.kind === 'add') {
          blockedAdds.add(f.variantId); // unaddable (e.g. 422) — stop retrying it this run
        }
      }
    }
    if (codeNeedsChange) {
      await io.setDiscount(plan.applyCode);
      appliedCode = plan.applyCode;
    }
    io.nudge?.();
  }

  return { passes: maxPasses, converged: false, appliedCode, failures };
}
