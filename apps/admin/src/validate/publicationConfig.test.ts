import { describe, expect, it, vi } from 'vitest';
import type { AdminGraphqlClient } from '@free-gift-engine/shopify';
import {
  hasPublicationsScope,
  MissingPublicationConfigError,
  resolveOnlineStorePublicationId,
} from './publicationConfig.js';

const OS_PUB_ID = 'gid://shopify/Publication/157545496685';

function mockClient(response: unknown): AdminGraphqlClient {
  return { request: vi.fn().mockResolvedValue(response) } as unknown as AdminGraphqlClient;
}

function pubNode(id: string, handle: string) {
  return { id, catalog: { apps: { nodes: [{ handle }] } } };
}

describe('resolveOnlineStorePublicationId', () => {
  it('returns the publication id matching app handle "online_store"', async () => {
    const client = mockClient({
      publications: {
        nodes: [
          pubNode(OS_PUB_ID, 'online_store'),
          pubNode('gid://shopify/Publication/2', 'pos'),
          pubNode('gid://shopify/Publication/3', 'shop-72'),
        ],
      },
    });
    expect(await resolveOnlineStorePublicationId(client)).toBe(OS_PUB_ID);
  });

  it('throws MissingPublicationConfigError when no publication matches online_store', async () => {
    const client = mockClient({
      publications: { nodes: [pubNode('gid://shopify/Publication/2', 'pos')] },
    });
    await expect(resolveOnlineStorePublicationId(client)).rejects.toThrow(
      MissingPublicationConfigError,
    );
  });

  it('throws MissingPublicationConfigError when the query itself fails (scope denied)', async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error('ACCESS_DENIED')),
    } as unknown as AdminGraphqlClient;
    await expect(resolveOnlineStorePublicationId(client)).rejects.toThrow(
      MissingPublicationConfigError,
    );
    await expect(resolveOnlineStorePublicationId(client)).rejects.toThrow(/read_publications/);
  });

  it('handles nodes with missing/null catalog gracefully (skips, does not throw)', async () => {
    const client = mockClient({
      publications: {
        nodes: [
          { id: 'gid://shopify/Publication/1', catalog: null },
          { id: 'gid://shopify/Publication/2' },
          pubNode(OS_PUB_ID, 'online_store'),
        ],
      },
    });
    expect(await resolveOnlineStorePublicationId(client)).toBe(OS_PUB_ID);
  });

  it('throws when the publications list is empty', async () => {
    const client = mockClient({ publications: { nodes: [] } });
    await expect(resolveOnlineStorePublicationId(client)).rejects.toThrow(
      MissingPublicationConfigError,
    );
  });
});

describe('hasPublicationsScope', () => {
  it('is true when the granted scope CSV includes read_publications (trim-tolerant)', () => {
    expect(hasPublicationsScope('read_products,write_discounts,read_publications')).toBe(true);
    expect(hasPublicationsScope(' read_products , read_publications ')).toBe(true);
  });

  it('is false when read_publications is absent (the stock-only fallback condition)', () => {
    expect(
      hasPublicationsScope('read_products,write_products,write_discounts,read_discounts'),
    ).toBe(false);
    expect(hasPublicationsScope('')).toBe(false);
  });
});
