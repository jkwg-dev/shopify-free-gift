// Webhook receiver: HMAC-verify (inside handleWebhook) then dispatch. app/uninstalled runs real
// cleanup; compliance topics are acknowledged. Thin adapter over the 3a handleWebhook. Node runtime.
import { getWebhookDeps } from '../../../src/validate/composition.js';
import { handleWebhook, WebhookAuthError } from '../../../src/webhooks/handlers.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const topic = request.headers.get('x-shopify-topic') ?? '';
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? '';
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') ?? '';

  try {
    const result = await handleWebhook(
      { topic, shopDomain, rawBody, hmacHeader },
      getWebhookDeps(shopDomain),
    );
    // 200 = handled; 202 = accepted/ignored (unknown topic). Both ack so Shopify won't retry.
    return new Response(null, { status: result.handled ? 200 : 202 });
  } catch (error) {
    if (error instanceof WebhookAuthError) {
      return new Response('Invalid HMAC', { status: 401 });
    }
    throw error;
  }
}
