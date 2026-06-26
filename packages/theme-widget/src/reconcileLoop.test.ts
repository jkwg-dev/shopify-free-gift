import { money, type ValidateResult } from '@free-gift-engine/core';
import { describe, expect, it, vi } from 'vitest';
import type { CartPost, PostResponse } from './cartMutations.js';
import { reconcileGiftCart, type GiftCartIo } from './reconcileLoop.js';

const PAID = 'gid://shopify/ProductVariant/1000';
const ICE = 'gid://shopify/ProductVariant/2001';
const BRUSH = 'gid://shopify/ProductVariant/3001';
const TEE = 'gid://shopify/ProductVariant/3002';
const VIDEO = 'gid://shopify/ProductVariant/4001';

const gidOf = (id: number): string => `gid://shopify/ProductVariant/${id}`;

function res(ok: boolean, status = ok ? 200 : 422, body = ''): PostResponse {
  return { ok, status, text: () => Promise.resolve(body) };
}

// In-memory cart mirroring the AJAX Cart API: cart/add.js MERGES by (variant + serialized properties)
// incrementing quantity (Shopify behaviour — re-adding the same gift bumps qty), cart/change.js sets
// or (qty 0) removes a line by its key.
class FakeCart {
  private seq = 0;
  readonly lines: {
    key: string;
    variantId: string;
    quantity: number;
    appAdded: boolean;
    propKey: string;
  }[] = [];

  seedPaid(variantId: string, quantity: number): void {
    this.seq += 1;
    this.lines.push({ key: `k${this.seq}`, variantId, quantity, appAdded: false, propKey: '{}' });
  }
  seedGift(variantId: string, quantity: number): void {
    this.seq += 1;
    const propKey = JSON.stringify({ _fge_gift: '1' });
    this.lines.push({ key: `k${this.seq}`, variantId, quantity, appAdded: true, propKey });
  }
  add(variantId: string, quantity: number, properties: Record<string, string> | undefined): void {
    const propKey = JSON.stringify(properties ?? {});
    const existing = this.lines.find((l) => l.variantId === variantId && l.propKey === propKey);
    if (existing) {
      existing.quantity += quantity; // merge (Shopify increments)
      return;
    }
    this.seq += 1;
    this.lines.push({
      key: `k${this.seq}`,
      variantId,
      quantity,
      appAdded: properties?.['_fge_gift'] != null,
      propKey,
    });
  }
  change(id: string, quantity: number): boolean {
    const idx = this.lines.findIndex((l) => l.key === id);
    if (idx === -1) return false;
    if (quantity === 0) this.lines.splice(idx, 1);
    else this.lines[idx]!.quantity = quantity;
    return true;
  }
  giftLines() {
    return this.lines.filter((l) => l.appAdded);
  }
}

// Build IO over a FakeCart. `result()` returns the current /validate result (flip it between
// reconcileGiftCart calls to simulate a tier change). add422 = variants whose cart/add.js 422s.
function makeIo(
  cart: FakeCart,
  result: () => ValidateResult | null,
  opts: { add422?: Set<string>; discounts?: string[] } = {},
): GiftCartIo & { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  const post: CartPost = (path, body) => {
    posts.push({ path, body });
    if (path === 'cart/add.js') {
      const items = (
        body as { items: { id: number; quantity: number; properties?: Record<string, string> }[] }
      ).items;
      const blocked = items.find((it) => opts.add422?.has(gidOf(it.id)));
      if (blocked) return Promise.resolve(res(false, 422, 'not published'));
      for (const it of items) cart.add(gidOf(it.id), it.quantity, it.properties);
      return Promise.resolve(res(true));
    }
    if (path === 'cart/change.js') {
      const b = body as { id: string; quantity: number };
      return Promise.resolve(res(cart.change(b.id, b.quantity)));
    }
    if (path === 'cart/update.js') {
      opts.discounts?.push((body as { discount: string }).discount);
      return Promise.resolve(res(true));
    }
    return Promise.resolve(res(true));
  };
  const io: GiftCartIo & { posts: typeof posts } = {
    posts,
    readCart: () =>
      Promise.resolve({
        lines: cart.lines.map((l) => ({
          id: l.key,
          variantId: l.variantId,
          quantity: l.quantity,
          appAdded: l.appAdded,
        })),
        currency: 'CAD',
      }),
    validate: () => Promise.resolve(result()),
    post,
    setDiscount: (code) => {
      opts.discounts?.push(code ?? '');
      return Promise.resolve();
    },
  };
  return io;
}

function giftResult(variantIds: string[], code: string): ValidateResult {
  return {
    status: 'gift',
    currency: 'CAD',
    subtotal: money(180000, 'CAD'),
    tierId: 't',
    giftVariantIds: variantIds,
    code,
    appliedThreshold: money(150000, 'CAD'),
  };
}

function countGift(cart: FakeCart, variantId: string): { lines: number; qty: number } {
  const ls = cart.giftLines().filter((l) => l.variantId === variantId);
  return { lines: ls.length, qty: ls.reduce((n, l) => n + l.quantity, 0) };
}

describe('reconcileGiftCart — BUG 1: no stacking, converges to one line @ qty 1', () => {
  it('running reconcile repeatedly for the same tier yields exactly ONE gift line, qty 1', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 3);
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    for (let i = 0; i < 5; i += 1) {
      await reconcileGiftCart(io);
    }

    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 }); // never stacked / bumped
    // After the first converge, later runs make NO cart writes (idempotent).
    const writesAfterFirst = io.posts.filter(
      (p, idx) => idx > 0 && (p.path === 'cart/add.js' || p.path === 'cart/change.js'),
    );
    // exactly one add (the initial) across all 5 runs
    expect(io.posts.filter((p) => p.path === 'cart/add.js')).toHaveLength(1);
    expect(writesAfterFirst.length).toBe(0);
  });

  it('self-heals a cart that already stacked the gift (qty 2) back to qty 1', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 3);
    cart.seedGift(ICE, 2); // a prior race bumped it to 2
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);

    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
  });

  it('self-heals duplicate/split gift lines of the same variant to a single line', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 3);
    cart.seedGift(ICE, 1);
    cart.seedGift(ICE, 1); // split into two lines
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);

    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
  });
});

describe('reconcileGiftCart — BUG 2: highest-tier-only across tier changes', () => {
  it('tier-2 (AND) -> tier-3 (OR) removes BOTH AND gifts and leaves only tier-3; back reverses', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    let current: ValidateResult = giftResult([BRUSH, TEE], 'CODE-AND');
    const io = makeIo(cart, () => current);

    await reconcileGiftCart(io); // tier 2: add BRUSH + TEE
    expect(countGift(cart, BRUSH)).toEqual({ lines: 1, qty: 1 });
    expect(countGift(cart, TEE)).toEqual({ lines: 1, qty: 1 });

    current = giftResult([VIDEO], 'CODE-VIDEO'); // cross into tier 3
    await reconcileGiftCart(io);
    expect(countGift(cart, BRUSH)).toEqual({ lines: 0, qty: 0 }); // previous tier removed
    expect(countGift(cart, TEE)).toEqual({ lines: 0, qty: 0 });
    expect(countGift(cart, VIDEO)).toEqual({ lines: 1, qty: 1 });
    expect(cart.giftLines()).toHaveLength(1); // ONLY the highest tier's gift

    current = giftResult([BRUSH, TEE], 'CODE-AND'); // drop back to tier 2
    await reconcileGiftCart(io);
    expect(countGift(cart, VIDEO)).toEqual({ lines: 0, qty: 0 });
    expect(countGift(cart, BRUSH)).toEqual({ lines: 1, qty: 1 });
    expect(countGift(cart, TEE)).toEqual({ lines: 1, qty: 1 });
  });
});

describe('reconcileGiftCart — safety', () => {
  it('a gift that always 422s on add is NOT retried in a loop (bounded, failure recorded)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    const io = makeIo(cart, () => giftResult([BRUSH], 'CODE-X'), { add422: new Set([BRUSH]) });

    const outcome = await reconcileGiftCart(io, { maxPasses: 4 });

    expect(outcome.converged).toBe(true); // converges (blocked add), does not exhaust passes
    expect(outcome.passes).toBeLessThanOrEqual(2);
    expect(outcome.failures.some((f) => f.kind === 'add' && f.variantId === BRUSH)).toBe(true);
    expect(countGift(cart, BRUSH)).toEqual({ lines: 0, qty: 0 }); // never added
    vi.restoreAllMocks();
  });

  it('leaves the cart untouched when /validate errors (null)', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    cart.seedGift(ICE, 1);
    const io = makeIo(cart, () => null);

    const outcome = await reconcileGiftCart(io);

    expect(outcome.converged).toBe(false);
    expect(io.posts.filter((p) => p.path !== 'cart/update.js')).toHaveLength(0); // no cart writes
    expect(cart.giftLines()).toHaveLength(1); // untouched
  });
});
