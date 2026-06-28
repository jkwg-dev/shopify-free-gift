// Embedded admin API: POST /api/admin/campaigns/[id]/activate (Phase 3c Stage C3).
// AUTH: the App Bridge session token via authenticateShop — same boundary as the other /api/admin/*
// routes. Ownership -> 404. Provisions + eager-mints, then the ATOMIC confirm-and-replace swap; if it
// would replace the live campaign and `confirmReplace` isn't set, returns 409 requiresConfirmation so
// the UI confirms and re-sends. Node runtime. App-Proxy routes are untouched.
import {
  authenticateShop,
  notFound,
  parseJsonBody,
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
    // Body is optional; default to no-confirm. Only parse when a JSON body is actually sent.
    let confirmReplace = false;
    if (request.headers.get('content-type')?.includes('application/json') === true) {
      const body = await parseJsonBody<{ confirmReplace?: boolean }>(request);
      confirmReplace = body.confirmReplace === true;
    }
    const campaign = await activateCampaignForDomain(shop, id, { confirmReplace });
    return campaign === null ? notFound('Campaign not found.') : Response.json(campaign);
  } catch (err) {
    return toErrorResponse(err);
  }
}
