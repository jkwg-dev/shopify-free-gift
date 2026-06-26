// Applies a reconciliation plan to the theme cart via the AJAX Cart API. Extracted from the
// storefront controller so the add/remove behaviour is unit-testable with an injected `post` (no DOM,
// no globals). The pure WHAT-to-change lives in core (reconcileGiftLines); this is the HOW.
//
// Key behaviours (Phase 5b-2a fix):
// - ADD-ALL atomically: every desired gift variant goes in ONE cart/add.js items[] (an AND tier adds
//   both gifts together). Shopify's cart/add.js is all-or-nothing, so on failure we FALL BACK to
//   per-item adds so any publishable variant still makes it in.
// - FAIL-SOFT: a failed add/remove (e.g. 422 because a gift product isn't published to the Online
//   Store channel) is recorded and surfaced (returned + console.warn), never silently swallowed, and
//   never aborts the other mutations. The returned result reflects what ACTUALLY made it into the cart.
import type { GiftReconciliation } from '@free-gift-engine/core';

// Minimal response shape (a real fetch Response satisfies this).
export type PostResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};

// Injected cart writer: POSTs a JSON body to an AJAX cart path (e.g. 'cart/add.js').
export type CartPost = (path: string, body: unknown) => Promise<PostResponse>;

export type CartMutationFailure = {
  readonly kind: 'add' | 'remove';
  readonly variantId: string;
  readonly status: number;
  readonly body: string;
};

export type CartMutationResult = {
  readonly added: readonly string[]; // gift variant GIDs now in the cart
  readonly removed: readonly string[]; // line ids removed
  readonly adjusted: readonly string[]; // line ids re-set to qty 1
  readonly failures: readonly CartMutationFailure[];
};

const toNumericId = (gid: string): number => Number(gid.split('/').pop());

const addItem = (a: GiftReconciliation['add'][number]) => ({
  id: toNumericId(a.variantId),
  quantity: a.quantity,
  properties: a.properties,
});

export async function applyCartPlan(
  plan: GiftReconciliation,
  post: CartPost,
): Promise<CartMutationResult> {
  const removed: string[] = [];
  const added: string[] = [];
  const adjusted: string[] = [];
  const failures: CartMutationFailure[] = [];

  // Remove ALL undesired app-added gift lines (e.g. an AND tier dropping below threshold removes both
  // its variants, or duplicate split lines — plan.remove already lists every one). Per-line by key; fail-soft.
  for (const r of plan.remove) {
    const res = await post('cart/change.js', { id: r.id, quantity: 0 });
    if (res.ok) {
      removed.push(r.id);
    } else {
      failures.push({
        kind: 'remove',
        variantId: r.variantId,
        status: res.status,
        body: await res.text(),
      });
    }
  }

  // Collapse any bumped gift line back to qty 1 (a rapid double-add inflated it). Per-line by key; fail-soft.
  for (const a of plan.adjust) {
    const res = await post('cart/change.js', { id: a.id, quantity: a.quantity });
    if (res.ok) {
      adjusted.push(a.id);
    } else {
      failures.push({
        kind: 'remove',
        variantId: a.variantId,
        status: res.status,
        body: await res.text(),
      });
    }
  }

  if (plan.add.length > 0) {
    // Atomic happy path: all desired gifts in one request.
    const res = await post('cart/add.js', { items: plan.add.map(addItem) });
    if (res.ok) {
      added.push(...plan.add.map((a) => a.variantId));
    } else {
      // Batch is all-or-nothing, so nothing was added. Surface, then retry per-item so each
      // publishable variant still gets in and only the offending one(s) are recorded as failed.
      const body = await res.text();
      logFailure(`batched cart/add.js failed (${res.status}); retrying per item`, body);
      for (const a of plan.add) {
        const one = await post('cart/add.js', { items: [addItem(a)] });
        if (one.ok) {
          added.push(a.variantId);
        } else {
          const oneBody = await one.text();
          failures.push({ kind: 'add', variantId: a.variantId, status: one.status, body: oneBody });
          logFailure(`cart/add.js failed for ${a.variantId} (${one.status})`, oneBody);
        }
      }
    }
  }

  return { added, removed, adjusted, failures };
}

function logFailure(message: string, body: string): void {
  // Surface to the storefront console; the perception UX for failures is 5b-2b.
  const c = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
  c?.warn?.(`[free-gift] ${message}`, body.slice(0, 300));
}
