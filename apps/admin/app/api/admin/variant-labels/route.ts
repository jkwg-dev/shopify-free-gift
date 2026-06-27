// Embedded admin API: POST /api/admin/variant-labels — resolve gift variant GIDs to display labels
// ("Product — Variant", or just "Product" for a single-variant product) for the editor's variant
// picker. AUTH: the App Bridge session token (Bearer JWT) via authenticateShop — same boundary as the
// other /api/admin/* routes. The label source is shared with the edit view, so picker-added and
// edit-loaded labels match. Node runtime. App-Proxy routes are untouched.
import {
  authenticateShop,
  parseJsonBody,
  toErrorResponse,
} from '../../../../src/admin/routeHelpers.js';
import { resolveVariantLabels } from '../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const { variantIds } = await parseJsonBody<{ variantIds?: readonly string[] }>(request);
    const ids = Array.isArray(variantIds) ? variantIds.filter((id) => typeof id === 'string') : [];
    const labels = await resolveVariantLabels(shop, ids);
    return Response.json({ labels });
  } catch (err) {
    return toErrorResponse(err);
  }
}
