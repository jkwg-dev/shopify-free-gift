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

export type MergedQuantityResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: string;
};

// Stage 2 (defect #2): set the merged quantity of a Shopify-SPLIT buy variant in ONE atomic
// `cart/update.js`. `writableKeys` are the UNMARKED line keys of the variant (ⓥ3 write-safety — a
// `_fge_gift`-marked line is never in this list, so a buy control can't zero a reconcile-owned line).
// We fold the whole controllable quantity onto the FIRST key and zero the rest, so the post-update
// cart has a single line for the variant (no lingering empty splits). Absolute target — never a delta:
//   "+" → T = Q+1, "−" → T = Q−1 (T=0 deletes the variant's controllable units), delete → T = 0.
// ONE request resolves all keys against the pre-update state at once; sequential per-key writes would
// re-split/re-allocate and invalidate the remaining keys — that hazard IS defect #2.
export async function setMergedQuantity(
  post: CartPost,
  writableKeys: readonly string[],
  targetQty: number,
): Promise<MergedQuantityResult> {
  if (writableKeys.length === 0) {
    return { ok: true, status: 200 }; // nothing controllable to write (all-marked group) — no-op.
  }
  const target = Math.max(0, Math.trunc(targetQty));
  const updates: Record<string, number> = {};
  for (const [i, key] of writableKeys.entries()) {
    updates[key] = i === 0 ? target : 0; // first key carries the total; siblings collapse to 0.
  }
  const res = await post('cart/update.js', { updates });
  if (res.ok) {
    return { ok: true, status: res.status };
  }
  const body = await res.text();
  logFailure(`cart/update.js merged-qty failed (${res.status})`, body);
  return { ok: false, status: res.status, body };
}

// Stage 2 (defect B): atomically zero a set of line keys in ONE cart/update.js. Used to remove the
// reconcile-owned gift line(s) the merged-buy edit orphans (an AND tier removes both gifts together —
// one atomic update, never a per-line loop, so an intermediate "one gift still non-free" state that the
// VF would reject never exists). `keys` MUST be gift-line keys only (gets ∪ lingering), never a paid line.
export async function removeLines(
  post: CartPost,
  keys: readonly string[],
): Promise<MergedQuantityResult> {
  if (keys.length === 0) return { ok: true, status: 200 }; // nothing to remove — no-op.
  const updates: Record<string, number> = {};
  for (const k of keys) updates[k] = 0;
  const res = await post('cart/update.js', { updates });
  if (res.ok) return { ok: true, status: res.status };
  const body = await res.text();
  logFailure(`cart/update.js gift-removal failed (${res.status})`, body);
  return { ok: false, status: res.status, body };
}

export type MergedBuyEditResult = {
  // true => the buy edit is now reflected in the cart; false => caller must roll back its optimistic UI.
  readonly applied: boolean;
  // The raw response body of the FAILING write, for a display-only message (logic never branches on it).
  readonly failureBody: string | null;
};

// Stage 2 (defect B): apply a merged buy-row edit to the absolute target T, removing the orphaned gift
// first if the edit drops the cart below the gift's tier. PURE w.r.t. the DOM — `post` and `readGiftKeys`
// are injected so this is unit-testable. Flow (see docs/cart-two-group-grouping-design.md §M):
//   1. Attempt 1 — BUY-ONLY write. A within-tier reduce succeeds here (one write, no gift touched).
//   2. On any non-200, gate the retry on whether gift lines EXIST NOW (readGiftKeys), NOT on the 422 body
//      (a 422 can have other causes; core logic must never depend on the body text). No gift lines => fail.
//   3. Gift-FIRST atomic sequence — Step A zeroes the orphaned gift key(s) while the cart STILL qualifies
//      (no marked line remains => the VF passes); Step B applies the buy target (now below threshold => no
//      marked line => the VF passes). Gift-first guarantees every intermediate cart is VF-valid, with no
//      assumption about WHEN the VF evaluates a combined update.
// On any failure the cart is left as the last successful write; the caller re-validates via reconcile.
export async function applyMergedBuyEdit(
  post: CartPost,
  writableKeys: readonly string[],
  targetQty: number,
  readGiftKeys: () => Promise<readonly string[]>,
): Promise<MergedBuyEditResult> {
  const r1 = await setMergedQuantity(post, writableKeys, targetQty);
  if (r1.ok) return { applied: true, failureBody: null };

  const giftKeys = await readGiftKeys();
  if (giftKeys.length === 0) return { applied: false, failureBody: r1.body ?? null };

  const rA = await removeLines(post, giftKeys);
  if (!rA.ok) return { applied: false, failureBody: rA.body ?? null };
  const rB = await setMergedQuantity(post, writableKeys, targetQty);
  if (!rB.ok) return { applied: false, failureBody: rB.body ?? null };
  return { applied: true, failureBody: null };
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
