import type { GiftReconciliation } from '@free-gift-engine/core';
import { describe, expect, it, vi } from 'vitest';
import { applyCartPlan, type CartPost, type PostResponse } from './cartMutations.js';

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

describe('applyCartPlan — remove path', () => {
  it('removes ALL undesired gift lines (e.g. AND drop-below removes both) and is fail-soft', async () => {
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
    // First removal fails (stale key), second succeeds — failure recorded, other still attempted.
    const { post, calls } = recordingPost((_path, body) =>
      (body as { id: string }).id === 'lineHidden' ? res(false, 404, 'gone') : res(true),
    );

    const result = await applyCartPlan(plan, post);

    expect(calls.filter((c) => c.path === 'cart/change.js')).toHaveLength(2);
    expect(result.removed).toEqual(['lineMulti']);
    expect(result.failures).toEqual([
      { kind: 'remove', variantId: HIDDEN, status: 404, body: 'gone' },
    ]);
  });
});
