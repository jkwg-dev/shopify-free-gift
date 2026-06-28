import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeDiscountGateway, FakeMappingTable, FakeShopRepository } from '../testing/fakes.js';
import { handleWebhook, WebhookAuthError, type WebhookDeps } from './handlers.js';

const apiSecret = 'shpss_secret';

function sign(body: string): string {
  return createHmac('sha256', apiSecret).update(body, 'utf8').digest('base64');
}

async function seededDeps(): Promise<
  WebhookDeps & {
    shopRepo: FakeShopRepository;
    mappingTable: FakeMappingTable;
    gateway: FakeDiscountGateway;
  }
> {
  const shopRepo = new FakeShopRepository();
  shopRepo.seedInstalled({
    id: 's1',
    domain: 'our-store.myshopify.com',
    encryptedAccessToken: 'enc',
    scopes: 'read_products',
    installedAt: new Date(0),
    uninstalledAt: null,
  });
  const mappingTable = new FakeMappingTable();
  const pending = await mappingTable.insertPending({
    campaignId: 'c1',
    tierPosition: 1,
    resolvedGiftSetHash: 'g1',
    configVersionHash: 'v1',
  });
  await mappingTable.finalize(pending.id, { code: 'CODE', discountId: 'disc-1' });
  return { apiSecret, shopRepo, mappingTable, gateway: new FakeDiscountGateway() };
}

describe('handleWebhook', () => {
  it('rejects an invalid HMAC before any processing', async () => {
    const deps = await seededDeps();
    await expect(
      handleWebhook(
        {
          topic: 'app/uninstalled',
          shopDomain: 'our-store.myshopify.com',
          rawBody: '{}',
          hmacHeader: 'bad',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it('app/uninstalled marks the shop uninstalled and deactivates its discounts', async () => {
    const deps = await seededDeps();
    const body = JSON.stringify({ shop_domain: 'our-store.myshopify.com' });

    const result = await handleWebhook(
      {
        topic: 'app/uninstalled',
        shopDomain: 'our-store.myshopify.com',
        rawBody: body,
        hmacHeader: sign(body),
      },
      deps,
    );

    expect(result.handled).toBe(true);
    expect(deps.shopRepo.uninstalled).toEqual(['our-store.myshopify.com']);
    expect(deps.gateway.deactivated).toEqual(['disc-1']);
    expect(await deps.mappingTable.findActiveByShop('s1')).toHaveLength(0);
  });

  it('acknowledges a verified compliance webhook (no PII to redact)', async () => {
    const deps = await seededDeps();
    const body = JSON.stringify({ shop_domain: 'our-store.myshopify.com' });
    const result = await handleWebhook(
      {
        topic: 'customers/redact',
        shopDomain: 'our-store.myshopify.com',
        rawBody: body,
        hmacHeader: sign(body),
      },
      deps,
    );
    expect(result.handled).toBe(true);
  });

  it('reports an unknown verified topic as unhandled', async () => {
    const deps = await seededDeps();
    const body = '{}';
    const result = await handleWebhook(
      {
        topic: 'orders/create',
        shopDomain: 'our-store.myshopify.com',
        rawBody: body,
        hmacHeader: sign(body),
      },
      deps,
    );
    expect(result.handled).toBe(false);
  });
});
