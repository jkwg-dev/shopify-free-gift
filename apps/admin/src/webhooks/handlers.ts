import type { GiftCodeMappingTable, ShopRepository, ShopifyDiscountGateway } from '../ports.js';
import { verifyWebhookHmac } from '../security/hmac.js';

// Inbound webhook handling. Every webhook is HMAC-verified before any processing; an invalid HMAC
// throws WebhookAuthError (the route returns 401). app/uninstalled runs real cleanup.
//
// Compliance webhooks (customers/data_request, customers/redact, shop/redact) are MANDATORY only
// for App-Store/public apps. This is a custom-distribution app for a single internal store and
// stores no shopper PII (only shop tokens, campaign config, and opaque discount codes), so they
// are not strictly required — but we verify and acknowledge them so the app stays compliant if
// distribution ever changes. There is no shopper data to return or redact.

export const APP_UNINSTALLED = 'app/uninstalled';
export const COMPLIANCE_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export class WebhookAuthError extends Error {
  constructor() {
    super('Invalid webhook HMAC');
    this.name = 'WebhookAuthError';
  }
}

export type WebhookDeps = {
  readonly apiSecret: string;
  readonly shopRepo: ShopRepository;
  readonly mappingTable: GiftCodeMappingTable;
  readonly gateway: ShopifyDiscountGateway;
};

export type WebhookRequest = {
  readonly topic: string;
  readonly shopDomain: string;
  readonly rawBody: string;
  readonly hmacHeader: string;
};

export async function handleWebhook(
  request: WebhookRequest,
  deps: WebhookDeps,
): Promise<{ handled: boolean }> {
  if (!verifyWebhookHmac(request.rawBody, request.hmacHeader, deps.apiSecret)) {
    throw new WebhookAuthError();
  }

  if (request.topic === APP_UNINSTALLED) {
    await handleAppUninstalled(request.shopDomain, deps);
    return { handled: true };
  }

  if ((COMPLIANCE_TOPICS as readonly string[]).includes(request.topic)) {
    // HMAC verified; no shopper PII held, so nothing to return or erase. Acknowledge.
    return { handled: true };
  }

  return { handled: false };
}

// Mark the shop uninstalled (stops minting) and deactivate its discounts. Deactivation is
// best-effort: the offline token is revoked on uninstall, so the Shopify call may fail — we still
// mark every mapping inactive locally so no stale code is ever served again.
async function handleAppUninstalled(shopDomain: string, deps: WebhookDeps): Promise<void> {
  await deps.shopRepo.markUninstalled(shopDomain);
  const shop = await deps.shopRepo.findByDomain(shopDomain);
  if (shop === null) {
    return;
  }
  const mappings = await deps.mappingTable.findActiveByShop(shop.id);
  for (const mapping of mappings) {
    if (mapping.discountId !== null) {
      try {
        await deps.gateway.deactivateDiscount(mapping.discountId);
      } catch {
        // Token likely revoked by the uninstall; local deactivation below is what matters.
      }
    }
    await deps.mappingTable.markInactive(mapping.id);
  }
}
