import type { GiftReconciliation } from '@free-gift-engine/core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCartPlan,
  applyMergedBuyEdit,
  failedAddVariantIds,
  removeLines,
  setMergedQuantity,
  type CartMutationFailure,
  type CartPost,
  type PostResponse,
} from './cartMutations.js';

const HIDDEN = 'gid://shopify/ProductVariant/301037';
const MULTI = 'gid://shopify/ProductVariant/595949';

function res(ok: boolean, status = ok ? 200 : 422, body = ''): PostResponse {
  return { ok, status, text: () => Promise.resolve(body) };
}

function addPlan(variantIds: string[]): GiftReconciliation {
  return {
    add: variantIds.map((variantId) => ({
      variantId,
      quantity: 1 as const,
      properties: { _fge_gift: '1' },
    })),
    remove: [],
    adjust: [],
    applyCode: 'CODE-AND',
    status: 'gift',
    reason: null,
  };
}

type AddBody = { items: { id: number; quantity: number; properties: Record<string, string> }[] };

// Records every (path, body) the plan posts.
function recordingPost(handler: (path: string, body: unknown) => PostResponse): {
  post: CartPost;
  calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  const post: CartPost = (path, body) => {
    calls.push({ path, body });
    return Promise.resolve(handler(path, body));
  };
  return { post, calls };
}

describe('applyCartPlan — AND tier adds ALL variants', () => {
  it('adds both AND variants in a SINGLE cart/add.js (items[2])', async () => {
    const { post, calls } = recordingPost(() => res(true));

    const result = await applyCartPlan(addPlan([HIDDEN, MULTI]), post);

    const adds = calls.filter((c) => c.path === 'cart/add.js');
    expect(adds).toHaveLength(1); // ONE batched call, not one-per-item
    const batchItems = (adds[0]!.body as AddBody).items;
    expect(batchItems).toHaveLength(2);
    expect(batchItems.map((i) => i.id)).toEqual([301037, 595949]);
    expect(result.added).toEqual([HIDDEN, MULTI]);
    expect(result.failures).toEqual([]);
  });

  it('on a 422 batch, retries per item: reports the failure AND still adds the other', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Batched add 422s (one variant unpublished); per-item: Hidden 422, Multi succeeds.
    const { post, calls } = recordingPost((path, body) => {
      if (path !== 'cart/add.js') return res(true);
      const items = (body as { items: { id: number }[] }).items;
      if (items.length > 1) return res(false, 422, 'not published'); // batch fails
      return items[0]!.id === 301037 ? res(false, 422, 'Hidden not published') : res(true);
    });

    const result = await applyCartPlan(addPlan([HIDDEN, MULTI]), post);

    const adds = calls.filter((c) => c.path === 'cart/add.js');
    expect(adds).toHaveLength(3); // batch + 2 per-item retries
    expect(result.added).toEqual([MULTI]); // the publishable one still made it in
    expect(result.failures).toEqual([
      { kind: 'add', variantId: HIDDEN, status: 422, body: 'Hidden not published' },
    ]);
    expect(warn).toHaveBeenCalled(); // failure surfaced, not silently swallowed
    warn.mockRestore();
  });
});

describe('applyCartPlan — adjust path (collapse a bumped gift qty to 1)', () => {
  it('re-sets a bumped gift line to qty 1 via cart/change.js (no re-add)', async () => {
    const plan: GiftReconciliation = {
      add: [],
      remove: [],
      adjust: [{ id: 'lineHidden', variantId: HIDDEN, quantity: 1 }],
      applyCode: 'CODE-AND',
      status: 'gift',
      reason: null,
    };
    const { post, calls } = recordingPost(() => res(true));

    const result = await applyCartPlan(plan, post);

    const changes = calls.filter((c) => c.path === 'cart/change.js');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.body).toEqual({ id: 'lineHidden', quantity: 1 });
    expect(calls.filter((c) => c.path === 'cart/add.js')).toHaveLength(0); // never re-adds
    expect(result.adjusted).toEqual(['lineHidden']);
  });
});

describe('applyCartPlan — remove path (atomic cart/update.js)', () => {
  it('removes ALL gift lines in ONE atomic cart/update.js (AND tier: both zeroed together)', async () => {
    const plan: GiftReconciliation = {
      add: [],
      remove: [
        { id: 'lineHidden', variantId: HIDDEN },
        { id: 'lineMulti', variantId: MULTI },
      ],
      adjust: [],
      applyCode: null,
      status: 'no-gift',
      reason: 'below-threshold',
    };
    const { post, calls } = recordingPost(() => res(true));

    const result = await applyCartPlan(plan, post);

    const updates = calls.filter((c) => c.path === 'cart/update.js');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toEqual({ updates: { lineHidden: 0, lineMulti: 0 } });
    expect(result.removed).toEqual(['lineHidden', 'lineMulti']);
    expect(result.failures).toEqual([]);
  });

  it('on atomic failure, records ALL removals as failed (all-or-nothing)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plan: GiftReconciliation = {
      add: [],
      remove: [
        { id: 'lineHidden', variantId: HIDDEN },
        { id: 'lineMulti', variantId: MULTI },
      ],
      adjust: [],
      applyCode: null,
      status: 'no-gift',
      reason: 'below-threshold',
    };
    const { post, calls } = recordingPost(() => res(false, 422, 'blocked'));

    const result = await applyCartPlan(plan, post);

    expect(calls).toHaveLength(1);
    expect(result.removed).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.variantId)).toEqual([HIDDEN, MULTI]);
    expect(result.failures.every((f) => f.status === 422)).toBe(true);
    warn.mockRestore();
  });

  it('skips removal when plan.remove is empty (no cart/update.js posted)', async () => {
    const plan: GiftReconciliation = {
      add: [],
      remove: [],
      adjust: [],
      applyCode: null,
      status: 'no-gift',
      reason: 'below-threshold',
    };
    const { post, calls } = recordingPost(() => res(true));

    await applyCartPlan(plan, post);

    expect(calls).toHaveLength(0);
  });
});

describe('setMergedQuantity — atomic merged buy-line write (defect #2)', () => {
  it('folds the whole target onto the first key and zeroes the rest in ONE cart/update.js', async () => {
    const { post, calls } = recordingPost(() => res(true));

    const result = await setMergedQuantity(post, ['k0', 'k1', 'k2'], 5);

    expect(calls).toHaveLength(1); // ONE request, never sequential per-key
    expect(calls[0]!.path).toBe('cart/update.js');
    expect(calls[0]!.body).toEqual({ updates: { k0: 5, k1: 0, k2: 0 } });
    expect(result.ok).toBe(true);
  });

  it('delete (target 0) zeroes every key', async () => {
    const { post, calls } = recordingPost(() => res(true));

    await setMergedQuantity(post, ['k0', 'k1'], 0);

    expect(calls[0]!.body).toEqual({ updates: { k0: 0, k1: 0 } });
  });

  it('single (unsplit) key still uses the atomic update path', async () => {
    const { post, calls } = recordingPost(() => res(true));

    await setMergedQuantity(post, ['k0'], 3);

    expect(calls[0]!.body).toEqual({ updates: { k0: 3 } });
  });

  it('no controllable keys (all-marked group) is a no-op — never posts', async () => {
    const { post, calls } = recordingPost(() => res(true));

    const result = await setMergedQuantity(post, [], 2);

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('clamps negatives/fractions to a whole, non-negative target', async () => {
    const { post, calls } = recordingPost(() => res(true));

    await setMergedQuantity(post, ['k0'], -1);
    await setMergedQuantity(post, ['k1'], 2.9);

    expect((calls[0]!.body as { updates: Record<string, number> }).updates).toEqual({ k0: 0 });
    expect((calls[1]!.body as { updates: Record<string, number> }).updates).toEqual({ k1: 2 });
  });

  it('surfaces a failed write (returns ok:false + body, warns) without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { post } = recordingPost(() => res(false, 422, 'cart locked'));

    const result = await setMergedQuantity(post, ['k0', 'k1'], 4);

    expect(result).toEqual({ ok: false, status: 422, body: 'cart locked' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('removeLines — atomic gift removal (defect B, Step A)', () => {
  it('zeroes ALL given keys in ONE cart/update.js (AND tier: both gifts together)', async () => {
    const { post, calls } = recordingPost(() => res(true));

    const result = await removeLines(post, ['g1', 'g2']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('cart/update.js');
    expect(calls[0]!.body).toEqual({ updates: { g1: 0, g2: 0 } });
    expect(result.ok).toBe(true);
  });

  it('empty keys is a no-op (never posts)', async () => {
    const { post, calls } = recordingPost(() => res(true));
    const result = await removeLines(post, []);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('surfaces a failed removal (ok:false + body) without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { post } = recordingPost(() => res(false, 422, 'blocked'));
    const result = await removeLines(post, ['g1']);
    expect(result).toEqual({ ok: false, status: 422, body: 'blocked' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('applyMergedBuyEdit — buy edit with gift-first orphan handling (defect B)', () => {
  const giftKeys = (...keys: string[]): (() => Promise<string[]>) => {
    return () => Promise.resolve(keys);
  };

  it('within-tier reduce: Attempt 1 (buy-only) succeeds in ONE write, gift never touched', async () => {
    const readGifts = vi.fn(giftKeys('g1'));
    const { post, calls } = recordingPost(() => res(true));

    const result = await applyMergedBuyEdit(post, ['k0', 'k1'], 6, readGifts);

    expect(result).toEqual({ applied: true, failureBody: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ updates: { k0: 6, k1: 0 } });
    expect(readGifts).not.toHaveBeenCalled(); // no 422 => no gift read, no gift touched
  });

  it('below-threshold reduce: Attempt 1 422s => gift-FIRST (Step A zero gifts, Step B buy)', async () => {
    let firstBuy = true;
    const { post, calls } = recordingPost((path, body) => {
      const u = (body as { updates: Record<string, number> }).updates;
      // The buy-only attempt 1 (only writableKeys present) 422s; the gift removal + final buy succeed.
      if (path === 'cart/update.js' && u['k0'] !== undefined && u['g1'] === undefined && firstBuy) {
        firstBuy = false;
        return res(false, 422, 'gift orphaned');
      }
      return res(true);
    });

    const result = await applyMergedBuyEdit(post, ['k0', 'k1'], 0, giftKeys('g1', 'g2'));

    expect(result).toEqual({ applied: true, failureBody: null });
    expect(calls.map((c) => c.body)).toEqual([
      { updates: { k0: 0, k1: 0 } }, // attempt 1 (buy-only) — 422
      { updates: { g1: 0, g2: 0 } }, // Step A — atomic gift removal (cart still qualifies)
      { updates: { k0: 0, k1: 0 } }, // Step B — buy write (now below threshold)
    ]);
  });

  it('422 with NO gift lines present => no retry, reports failure (caller rolls back)', async () => {
    const { post, calls } = recordingPost(() => res(false, 422, 'some other error'));

    const result = await applyMergedBuyEdit(post, ['k0'], 2, giftKeys());

    expect(result).toEqual({ applied: false, failureBody: 'some other error' });
    expect(calls).toHaveLength(1); // only attempt 1; no gift keys => no gift-first sequence
  });

  it('gift-first Step A fails (e.g. issue-#6 marked paid line remains) => not applied, surfaces body', async () => {
    // Attempt 1 422s; gift removal also 422s (a marked paid line still leaves the VF blocking).
    const { post, calls } = recordingPost(() => res(false, 422, 'still blocked'));

    const result = await applyMergedBuyEdit(post, ['k0'], 0, giftKeys('g1'));

    expect(result).toEqual({ applied: false, failureBody: 'still blocked' });
    expect(calls).toHaveLength(2); // attempt 1 (422) + Step A (422) — no Step B
  });
});

describe('failedAddVariantIds', () => {
  it('returns only the variant ids of failed ADDs (for the chooser unavailable set)', () => {
    const failures: CartMutationFailure[] = [
      { kind: 'add', variantId: HIDDEN, status: 422, body: 'not published' },
      { kind: 'remove', variantId: MULTI, status: 404, body: 'gone' },
      { kind: 'add', variantId: MULTI, status: 422, body: 'oos' },
    ];
    expect(failedAddVariantIds(failures)).toEqual([HIDDEN, MULTI]);
    expect(failedAddVariantIds([])).toEqual([]);
  });
});
