import { describe, expect, it } from 'vitest';
import { resolveRootEntry } from './rootEntry.js';

const installed = { isInstalled: () => Promise.resolve(true) };
const notInstalled = { isInstalled: () => Promise.resolve(false) };

describe('resolveRootEntry', () => {
  it('redirects a not-installed shop to OAuth begin (the fix)', async () => {
    const result = await resolveRootEntry('our-store.myshopify.com', notInstalled);
    expect(result).toEqual({
      kind: 'redirect',
      location: '/api/auth?shop=our-store.myshopify.com',
    });
  });

  it('returns a 200 placeholder for an installed shop (no embedded UI yet)', async () => {
    const result = await resolveRootEntry('our-store.myshopify.com', installed);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.body).toMatch(/installed/i);
  });

  it('returns an info page when shop is missing (never redirects to Shopify)', async () => {
    expect((await resolveRootEntry(null, installed)).kind).toBe('ok');
    expect((await resolveRootEntry('', installed)).kind).toBe('ok');
  });

  it('rejects an invalid (non-myshopify) shop before redirecting (open-redirect guard)', async () => {
    for (const bad of [
      'evil.com',
      'shop.example.com',
      'not a domain',
      'evil.myshopify.com.attacker.com',
    ]) {
      expect((await resolveRootEntry(bad, notInstalled)).kind).toBe('bad-request');
    }
  });

  it('does not consult install state for an invalid shop', async () => {
    let called = false;
    const result = await resolveRootEntry('evil.com', {
      isInstalled: () => {
        called = true;
        return Promise.resolve(false);
      },
    });
    expect(result.kind).toBe('bad-request');
    expect(called).toBe(false);
  });
});
