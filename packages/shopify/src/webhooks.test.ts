import { describe, expect, it } from 'vitest';
import { AdminGraphqlClient } from './client.js';
import { ShopifyUserError } from './errors.js';
import { mockFetch, parseBody, testConfig } from './test-helpers.js';
import { APP_UNINSTALLED_TOPIC, registerAppUninstalledWebhook } from './webhooks.js';

describe('registerAppUninstalledWebhook', () => {
  it('subscribes to app/uninstalled delivering JSON to the uri', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' },
              userErrors: [],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    const result = await registerAppUninstalledWebhook(client, 'https://app.example.com/webhooks');

    expect(result).toEqual({ id: 'gid://shopify/WebhookSubscription/1' });
    expect(parseBody(calls[0]!).variables).toEqual({
      topic: APP_UNINSTALLED_TOPIC,
      webhookSubscription: { uri: 'https://app.example.com/webhooks', format: 'JSON' },
    });
  });

  it('throws ShopifyUserError when registration reports a userError', async () => {
    const { fetch } = mockFetch([
      {
        body: {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ message: 'Invalid uri' }],
            },
          },
        },
      },
    ]);
    const client = new AdminGraphqlClient(testConfig(fetch));

    await expect(registerAppUninstalledWebhook(client, 'not-a-url')).rejects.toBeInstanceOf(
      ShopifyUserError,
    );
  });
});
