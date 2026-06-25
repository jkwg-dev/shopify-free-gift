import type { GiftCodeMappingTable, ShopifyDiscountGateway } from '../ports.js';

export type SupersedeDeps = {
  readonly mappingTable: GiftCodeMappingTable;
  readonly gateway: ShopifyDiscountGateway;
};

// After a campaign's scope-determining config changes, deactivate every active mapping whose
// configVersionHash is no longer current — both the Shopify discount and our row. Live codes are
// never mutated; we supersede. Idempotent: if nothing is stale (hash unchanged), it is a no-op.
export async function supersedeStaleDiscounts(
  campaignId: string,
  currentConfigVersionHash: string,
  deps: SupersedeDeps,
): Promise<{ deactivated: number }> {
  const active = await deps.mappingTable.findActiveByCampaign(campaignId);
  const stale = active.filter((m) => m.configVersionHash !== currentConfigVersionHash);

  for (const mapping of stale) {
    if (mapping.discountId !== null) {
      await deps.gateway.deactivateDiscount(mapping.discountId);
    }
    await deps.mappingTable.markInactive(mapping.id);
  }

  return { deactivated: stale.length };
}
