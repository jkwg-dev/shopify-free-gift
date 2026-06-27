// Embedded admin API: POST /api/admin/campaigns/[id]/deactivate (Phase 3c Stage C1, flip-only).
// AUTH: the App Bridge session token via authenticateShop. Ownership -> 404. Node runtime. App-Proxy
// routes are untouched. (Code teardown is C2/C3; C1 only flips the flag.)
import {
  authenticateShop,
  notFound,
  toErrorResponse,
} from '../../../../../../src/admin/routeHelpers.js';
import { deactivateCampaignForDomain } from '../../../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { readonly params: Promise<{ readonly id: string }> };

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const { id } = await ctx.params;
    const campaign = await deactivateCampaignForDomain(shop, id);
    return campaign === null ? notFound('Campaign not found.') : Response.json(campaign);
  } catch (err) {
    return toErrorResponse(err);
  }
}
