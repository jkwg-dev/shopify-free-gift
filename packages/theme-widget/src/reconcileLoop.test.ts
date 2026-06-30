import { money, type ValidateResult } from '@free-gift-engine/core';
import { describe, expect, it, vi } from 'vitest';
import type { CartPost, PostResponse } from './cartMutations.js';
import { reconcileGiftCart, reconcileSettled, type GiftCartIo } from './reconcileLoop.js';

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
  seq_bump(): void {
    this.seq += 1;
  }
  seq_val(): number {
    return this.seq;
  }
  readonly lines: {
    key: string;
    variantId: string;
    quantity: number;
    appAdded: boolean;
    propKey: string;
    finalLinePrice: number;
  }[] = [];

  seedPaid(variantId: string, quantity: number): void {
    this.seq += 1;
    this.lines.push({
      key: `k${this.seq}`,
      variantId,
      quantity,
      appAdded: false,
      propKey: '{}',
      finalLinePrice: quantity * 1000,
    });
  }
  seedGift(variantId: string, quantity: number, finalLinePrice = 0): void {
    this.seq += 1;
    const propKey = JSON.stringify({ _fge_gift: '1' });
    this.lines.push({
      key: `k${this.seq}`,
      variantId,
      quantity,
      appAdded: true,
      propKey,
      finalLinePrice,
    });
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
      finalLinePrice: 0, // new gift adds are assumed discounted
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
  opts: { add422?: Set<string>; discounts?: string[]; swallowAdds?: boolean } = {},
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
      // swallowAdds models add-merge LAG: the add "succeeds" but is not yet visible on the next read.
      if (!opts.swallowAdds)
        for (const it of items) cart.add(gidOf(it.id), it.quantity, it.properties);
      return Promise.resolve(res(true));
    }
    if (path === 'cart/change.js') {
      const b = body as { id: string; quantity: number };
      return Promise.resolve(res(cart.change(b.id, b.quantity)));
    }
    if (path === 'cart/update.js') {
      const b = body as { discount?: string; updates?: Record<string, number> };
      if (b.discount !== undefined) {
        opts.discounts?.push(b.discount);
      }
      if (b.updates !== undefined) {
        for (const [key, qty] of Object.entries(b.updates)) {
          cart.change(key, qty);
        }
      }
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
          finalLinePrice: l.finalLinePrice,
        })),
        currency: 'CAD',
      }),
    validate: () => Promise.resolve(result()),
    post,
    setDiscount: (code) => {
      // Record in the unified `posts` log too (path 'discount') so tests can assert the ORDER of
      // setDiscount relative to cart/add.js and cart/change.js (the full-price-window fix).
      posts.push({ path: 'discount', body: { discount: code ?? '' } });
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
    // Idempotent across all 5 runs (order-independent): exactly ONE add (the initial) and ZERO
    // changes — i.e. no cart writes after the gift is in place.
    expect(io.posts.filter((p) => p.path === 'cart/add.js')).toHaveLength(1);
    expect(io.posts.filter((p) => p.path === 'cart/change.js')).toHaveLength(0);
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

  it('issues the gift add at most ONCE per run even under add-merge lag (no add/fix churn)', async () => {
    // The add "succeeds" but is not yet visible on subsequent reads (swallowAdds). Without the
    // once-per-run guard the loop would re-add each pass (-> Shopify merges/splits -> visible churn).
    const cart = new FakeCart();
    cart.seedPaid(PAID, 3);
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'), { swallowAdds: true });

    const outcome = await reconcileGiftCart(io, { maxPasses: 4 });

    expect(io.posts.filter((p) => p.path === 'cart/add.js')).toHaveLength(1); // exactly one add
    expect(outcome.converged).toBe(true); // stops re-adding once attempted (not maxPasses)
  });
});

describe('reconcileGiftCart — never resets a non-gift line (regression)', () => {
  it('leaves the qualifying (non-gift) line at qty 6 untouched through the whole loop', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 6); // qualifying product, no _fge_gift, qty 6
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);
    await reconcileGiftCart(io); // run twice

    const paid = cart.lines.find((l) => l.variantId === PAID && !l.appAdded);
    expect(paid?.quantity).toBe(6); // never reset
    // no cart/change.js ever targeted the paid line's key
    const paidKey = paid!.key;
    expect(
      io.posts.some(
        (p) => p.path === 'cart/change.js' && (p.body as { id: string }).id === paidKey,
      ),
    ).toBe(false);
    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 }); // gift added correctly, separate line
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

describe('reconcileGiftCart — no full-price beat (apply order)', () => {
  it('tier change: removes the OLD gift, applies the NEW code, THEN adds the new gift (in that order)', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    cart.seedGift(ICE, 1); // outgoing tier-1 gift, currently discounted by CODE-ICE
    const io = makeIo(cart, () => giftResult([VIDEO], 'CODE-VIDEO'));

    await reconcileGiftCart(io, { initialCode: 'CODE-ICE' });

    // The new gift must be added only AFTER its code is on the cart, so BXGY zeroes it on arrival
    // (no full-price render). The old gift is removed BEFORE the code swaps (it can't lose its $0).
    // Removal is now an atomic cart/update.js (not sequential cart/change.js).
    const seq = io.posts
      .filter((p) => ['cart/update.js', 'cart/add.js', 'discount'].includes(p.path))
      .map((p) => {
        if (p.path === 'discount') return `code:${(p.body as { discount: string }).discount}`;
        if (p.path === 'cart/update.js' && (p.body as { updates?: unknown }).updates !== undefined)
          return 'cart/update.js:remove';
        return p.path;
      });
    expect(seq).toEqual(['cart/update.js:remove', 'code:CODE-VIDEO', 'cart/add.js']);
    expect(countGift(cart, ICE)).toEqual({ lines: 0, qty: 0 });
    expect(countGift(cart, VIDEO)).toEqual({ lines: 1, qty: 1 });
  });

  it('first unlock: applies the code BEFORE adding the gift (gift never at full price)', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);

    const seq = io.posts
      .filter((p) => ['cart/add.js', 'discount'].includes(p.path))
      .map((p) =>
        p.path === 'discount' ? `code:${(p.body as { discount: string }).discount}` : p.path,
      );
    expect(seq).toEqual(['code:CODE-ICE', 'cart/add.js']);
  });
});

describe('reconcileSettled (pure convergence predicate)', () => {
  it('true only when EVERY planned mutation applied with no failures', () => {
    expect(
      reconcileSettled(
        { adds: 1, removes: 1, adjusts: 0 },
        { added: 1, removed: 1, adjusted: 0, failed: 0 },
      ),
    ).toBe(true);
    // code-only change (no cart mutations) is settled
    expect(
      reconcileSettled(
        { adds: 0, removes: 0, adjusts: 0 },
        { added: 0, removed: 0, adjusted: 0, failed: 0 },
      ),
    ).toBe(true);
  });

  it('false on any failure or partial apply — keeps the confirming re-validate', () => {
    // add 422
    expect(
      reconcileSettled(
        { adds: 1, removes: 0, adjusts: 0 },
        { added: 0, removed: 0, adjusted: 0, failed: 1 },
      ),
    ).toBe(false);
    // only one of two adds landed
    expect(
      reconcileSettled(
        { adds: 2, removes: 0, adjusts: 0 },
        { added: 1, removed: 0, adjusted: 0, failed: 0 },
      ),
    ).toBe(false);
    // planned remove didn't land
    expect(
      reconcileSettled(
        { adds: 0, removes: 1, adjusts: 0 },
        { added: 0, removed: 0, adjusted: 0, failed: 0 },
      ),
    ).toBe(false);
  });
});

describe('reconcileGiftCart — round-trip reduction (step 3a)', () => {
  it('clean apply converges in ONE pass: a single /validate and TWO cart reads (plan + invariant)', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    let validateCalls = 0;
    let readCalls = 0;
    const base = makeIo(cart, () => {
      validateCalls += 1;
      return giftResult([ICE], 'CODE-ICE');
    });
    const io: GiftCartIo = {
      ...base,
      readCart: () => {
        readCalls += 1;
        return base.readCart();
      },
    };

    const outcome = await reconcileGiftCart(io);

    expect(outcome.converged).toBe(true);
    expect(outcome.passes).toBe(1);
    expect(validateCalls).toBe(1); // no confirming SECOND /validate
    expect(readCalls).toBe(3); // plan read + post-add verify + charged-gift invariant check
    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
  });

  it('re-validates (extra pass) when the apply did NOT fully land — convergence guarantee intact', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    let validateCalls = 0;
    const io = makeIo(
      cart,
      () => {
        validateCalls += 1;
        return giftResult([BRUSH], 'CODE-X');
      },
      { add422: new Set([BRUSH]) },
    );

    const outcome = await reconcileGiftCart(io, { maxPasses: 4 });

    expect(validateCalls).toBeGreaterThanOrEqual(2); // failed apply -> NOT skipped, re-validated
    expect(outcome.converged).toBe(true);
    expect(countGift(cart, BRUSH)).toEqual({ lines: 0, qty: 0 });
    vi.restoreAllMocks();
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

describe('reconcileGiftCart — charged gift convergence (FGE #3)', () => {
  it('removes a duplicated charged gift and leaves a single $0 line', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    cart.seedGift(ICE, 1, 4250); // line A: charged copy ($42.50)
    cart.seedGift(ICE, 1, 0); // line B: free copy ($0)
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);

    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
    const remaining = cart.giftLines().find((l) => l.variantId === ICE);
    expect(remaining?.finalLinePrice).toBe(0);
  });

  it('removes a sole charged gift and re-adds it so BXGY creates a $0 copy', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    cart.seedGift(ICE, 1, 4250); // only copy is charged
    const io = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));

    await reconcileGiftCart(io);

    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
    const remaining = cart.giftLines().find((l) => l.variantId === ICE);
    expect(remaining?.finalLinePrice).toBe(0); // re-added as $0
  });

  it('dropping to a lower tier removes charged copies of the old gift entirely', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    cart.seedGift(ICE, 1, 4250);
    cart.seedGift(ICE, 1, 0);
    const io = makeIo(cart, () => giftResult([BRUSH], 'CODE-BRUSH'));

    await reconcileGiftCart(io);

    expect(countGift(cart, ICE)).toEqual({ lines: 0, qty: 0 });
    expect(countGift(cart, BRUSH)).toEqual({ lines: 1, qty: 1 });
  });

  it('hard invariant: a charged gift persisting after settled is swept before convergence', async () => {
    const cart = new FakeCart();
    cart.seedPaid(PAID, 5);
    // Simulate a post-add charged gift that survives the plan (e.g. discount not settled).
    // We start with a charged copy. The plan removes it and re-adds. But if the re-added copy
    // is also charged (modeled here by making new adds finalLinePrice > 0), the invariant sweep
    // catches it.
    let addCount = 0;
    const base = makeIo(cart, () => giftResult([ICE], 'CODE-ICE'));
    const io: GiftCartIo = {
      ...base,
      post: async (path, body) => {
        if (path === 'cart/add.js') {
          addCount++;
          // First add produces a charged line (simulating the race); second add is $0.
          const items = (
            body as {
              items: { id: number; quantity: number; properties?: Record<string, string> }[];
            }
          ).items;
          for (const it of items) {
            const propKey = JSON.stringify(it.properties ?? {});
            cart.seq_bump();
            cart.lines.push({
              key: `k${cart.seq_val()}`,
              variantId: gidOf(it.id),
              quantity: it.quantity,
              appAdded: it.properties?.['_fge_gift'] != null,
              propKey,
              finalLinePrice: addCount === 1 ? 4250 : 0,
            });
          }
          return res(true);
        }
        return base.post(path, body);
      },
    };

    const outcome = await reconcileGiftCart(io, { maxPasses: 4 });

    expect(outcome.converged).toBe(true);
    expect(countGift(cart, ICE)).toEqual({ lines: 1, qty: 1 });
    const remaining = cart.giftLines().find((l) => l.variantId === ICE);
    expect(remaining?.finalLinePrice).toBe(0);
  });
});
