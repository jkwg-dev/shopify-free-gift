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

  // Remove ALL undesired app-added gift lines ATOMICALLY in ONE cart/update.js. An AND tier has two
  // gifts; sequential per-line cart/change.js would orphan one while the other is still present → the
  // BXGY allocation breaks → the remaining _fge_gift line reverts to full price → the VF blocks → 422
  // deadlock. The atomic write zeros all keys at once, so no intermediate cart has an orphaned gift.
  if (plan.remove.length > 0) {
    const updates: Record<string, number> = {};
    for (const r of plan.remove) updates[r.id] = 0;
    const res = await post('cart/update.js', { updates });
    if (res.ok) {
      removed.push(...plan.remove.map((r) => r.id));
    } else {
      const body = await res.text();
      logFailure(`cart/update.js atomic gift removal failed (${res.status})`, body);
      for (const r of plan.remove) {
        failures.push({ kind: 'remove', variantId: r.variantId, status: res.status, body });
      }
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

// The gift VARIANT GIDs that FAILED to add (e.g. 422 — unpublished/sold-out). Feeds the chooser's
// runtime `unavailableVariantIds` so the option is disabled + noted and never shown as added.
export function failedAddVariantIds(failures: readonly CartMutationFailure[]): string[] {
  return failures.filter((f) => f.kind === 'add').map((f) => f.variantId);
}

function logFailure(message: string, body: string): void {
  // Surface to the storefront console; the perception UX for failures is 5b-2b.
  const c = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
  c?.warn?.(`[free-gift] ${message}`, body.slice(0, 300));
}
