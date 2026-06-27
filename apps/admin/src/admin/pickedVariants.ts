// Pure flatten for the gift variant picker (Phase 3b). We pick with the PRODUCT resource picker
// (resourcePicker({ type: 'product', filter: { variants: true } })) because the VARIANT picker renders
// rows with only the variant title/price — blank or "$10" for single-variant ("Default Title")
// products, so the merchant can't tell which product a row belongs to. The product picker shows
// product-name rows and returns each selected product with its SELECTED variants; we flatten those to
// per-variant GIDs (our gift storage is per variant). No I/O — unit-tested; the App Bridge call lives
// in app/appBridge.ts. Display labels are still resolved server-side via /api/admin/variant-labels.

// The subset of the product picker payload we read: a product carries its SELECTED variants. (A
// product selected whole returns all its variants; one with specific variants expanded returns just
// those.) `variants` may be absent if nothing under it was selected.
export type PickedProduct = {
  readonly id: string;
  readonly variants?: readonly { readonly id: string }[];
};

// Flatten selected products to their variant GIDs, de-duplicated and order-preserving.
export function flattenPickedVariantIds(products: readonly PickedProduct[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      if (!seen.has(variant.id)) {
        seen.add(variant.id);
        ids.push(variant.id);
      }
    }
  }
  return ids;
}
