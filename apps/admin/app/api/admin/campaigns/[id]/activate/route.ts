// Embedded admin API: POST /api/admin/campaigns/[id]/activate (Phase 3c Stage C1, flip-only).
// AUTH: the App Bridge session token via authenticateShop — same boundary as the other /api/admin/*
// routes. Ownership -> 404; another active FGE campaign -> 400 (deactivate it first; the
// confirm-and-replace swap is C3). Node runtime. App-Proxy routes are untouched.
import {
  authenticateShop,
  notFound,
  toErrorResponse,
} from '../../../../../../src/admin/routeHelpers.js';
import { activateCampaignForDomain } from '../../../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { readonly params: Promise<{ readonly id: string }> };

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const { id } = await ctx.params;
    const campaign = await activateCampaignForDomain(shop, id);
    return campaign === null ? notFound('Campaign not found.') : Response.json(campaign);
  } catch (err) {
    return toErrorResponse(err);
  }
}
