import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { ShopifyGraphqlError, ShopifyHttpError, ShopifyThrottledError } from './errors.js';
import { mockFetch, testConfig } from './test-helpers.js';

const THROTTLED = {
  body: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] },
};

describe('AdminGraphqlClient.request', () => {
  it('posts to the pinned versioned endpoint with the access token header', async () => {
    const { fetch, calls } = mockFetch([{ body: { data: { ok: true } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await client.request('query { x }', { a: 1 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://our-store.myshopify.com/admin/api/2026-04/graphql.json');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers['X-Shopify-Access-Token']).toBe('shpat_test_token');
    expect(JSON.parse(call?.init.body ?? '{}')).toEqual({
      query: 'query { x }',
      variables: { a: 1 },
    });
  });

  it('returns the data payload on success', async () => {
    const { fetch } = mockFetch([{ body: { data: { value: 42 } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.request('query { value }', {})).resolves.toEqual({ value: 42 });
  });

  it('retries THROTTLED with backoff then succeeds', async () => {
    const { fetch, calls } = mockFetch([THROTTLED, THROTTLED, { body: { data: { ok: true } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(client.request('query { ok }', {})).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('throws ShopifyThrottledError after exhausting retries', async () => {
    const { fetch, calls } = mockFetch([THROTTLED, THROTTLED, THROTTLED, THROTTLED]);
    const client = new AdminGraphqlClient(testConfig(fetch, { maxRetries: 3 }));

    await expect(client.request('query { ok }', {})).rejects.toBeInstanceOf(ShopifyThrottledError);
    expect(calls).toHaveLength(4); // initial attempt + 3 retries
  });

  it('throws ShopifyGraphqlError for non-throttle GraphQL errors', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          errors: [{ message: 'Field does not exist', extensions: { code: 'undefinedField' } }],
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.request('query { nope }', {})).rejects.toBeInstanceOf(ShopifyGraphqlError);
  });

  it('throws ShopifyHttpError on a non-2xx response', async () => {
    const { fetch } = mockFetch([{ ok: false, status: 401, text: 'Unauthorized' }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.request('query { x }', {})).rejects.toBeInstanceOf(ShopifyHttpError);
  });

  it('throws when the body carries neither data nor errors', async () => {
    const { fetch } = mockFetch([{ body: {} }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.request('query { x }', {})).rejects.toBeInstanceOf(ShopifyGraphqlError);
  });
});

describe('AdminGraphqlClient.requestPartial', () => {
  it('returns { data, errors } WITHOUT throwing when partial data accompanies a field error', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: { nodes: [{ id: 'gid://v/1' }, null] },
          errors: [
            {
              message: 'Access denied',
              path: ['nodes', 1, 'product', 'publishedOnPublication'],
              extensions: { code: 'ACCESS_DENIED' },
            },
          ],
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const { data, errors } = await client.requestPartial<{ nodes: unknown[] }>(
      'query { nodes }',
      {},
    );
    expect(data).toEqual({ nodes: [{ id: 'gid://v/1' }, null] });
    expect(errors).toEqual([
      {
        message: 'Access denied',
        code: 'ACCESS_DENIED',
        path: ['nodes', 1, 'product', 'publishedOnPublication'],
      },
    ]);
  });

  it('returns errors with empty data (no throw) so a fully-nulled batch is still inspectable', async () => {
    const { fetch } = mockFetch([
      { body: { data: null, errors: [{ message: 'boom', path: ['nodes', 0] }] } },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    const { data, errors } = await client.requestPartial('query { nodes }', {});
    expect(data).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('still retries THROTTLED then succeeds (shares the transport with request)', async () => {
    const { fetch, calls } = mockFetch([THROTTLED, { body: { data: { ok: true } } }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.requestPartial('query { ok }', {})).resolves.toEqual({
      data: { ok: true },
      errors: [],
    });
    expect(calls).toHaveLength(2);
  });

  it('still throws ShopifyHttpError on a non-2xx response', async () => {
    const { fetch } = mockFetch([{ ok: false, status: 500, text: 'boom' }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.requestPartial('query { x }', {})).rejects.toBeInstanceOf(ShopifyHttpError);
  });

  it('still throws ShopifyThrottledError after exhausting retries', async () => {
    const { fetch } = mockFetch([THROTTLED, THROTTLED, THROTTLED, THROTTLED]);
    const client = new AdminGraphqlClient(testConfig(fetch, { maxRetries: 3 }));
    await expect(client.requestPartial('query { x }', {})).rejects.toBeInstanceOf(
      ShopifyThrottledError,
    );
  });

  it('throws ShopifyGraphqlError only when there is NEITHER data nor errors', async () => {
    const { fetch } = mockFetch([{ body: {} }]);
    const client = new AdminGraphqlClient(testConfig(fetch));
    await expect(client.requestPartial('query { x }', {})).rejects.toBeInstanceOf(
      ShopifyGraphqlError,
    );
  });
});
