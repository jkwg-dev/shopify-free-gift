import type { AdminGraphqlClient } from './client.js';
import { ShopifyUserError, type UserErrorDetail } from './errors.js';

// Only app/uninstalled is wired (for cleanup). Other topics are added only with a concrete
// handler (YAGNI, CLAUDE.md) — e.g. variant-deletion would need to actually deactivate the
// affected gift codes, so it stays out until that handler exists.
export const APP_UNINSTALLED_TOPIC = 'APP_UNINSTALLED' as const;

export type WebhookSubscription = { readonly id: string };

const REGISTER_MUTATION = `mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

type RegisterResponse = {
  readonly webhookSubscriptionCreate: {
    readonly webhookSubscription: { readonly id: string } | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
};

// Subscribe to app/uninstalled, delivering JSON to `uri` (an HTTPS endpoint). Returns the
// created subscription id.
export async function registerAppUninstalledWebhook(
  client: AdminGraphqlClient,
  uri: string,
): Promise<WebhookSubscription> {
  const data = await client.request<RegisterResponse>(REGISTER_MUTATION, {
    topic: APP_UNINSTALLED_TOPIC,
    webhookSubscription: { uri, format: 'JSON' },
  });
  const result = data.webhookSubscriptionCreate;
  if (result.userErrors.length > 0) {
    throw new ShopifyUserError(result.userErrors);
  }
  if (result.webhookSubscription === null) {
    throw new ShopifyUserError([{ message: 'webhookSubscriptionCreate returned no subscription' }]);
  }
  return result.webhookSubscription;
}
