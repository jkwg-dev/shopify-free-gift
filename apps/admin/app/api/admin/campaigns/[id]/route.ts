// Embedded admin API: a single campaign.
//   GET /api/admin/campaigns/[id]  — load one as an editor view (decimals + gift titles).
//   PUT /api/admin/campaigns/[id]  — edit a draft OR supersede a LIVE campaign (Phase 3c Q4).
// AUTH: the App Bridge session token (Bearer JWT) via authenticateShop — the SAME boundary as the
// collection route. Ownership is enforced in the composition layer (a campaign not owned by the
// verified shop returns 404, never leaking it). Node runtime. App-Proxy routes are untouched.
import {
  authenticateShop,
  notFound,
  parseJsonBody,
  toErrorResponse,
} from '../../../../../src/admin/routeHelpers.js';
import type { CampaignEditorInput } from '../../../../../src/admin/editorTypes.js';
import {
  getCampaignEditorView,
  supersedeCampaignForDomain,
} from '../../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { readonly params: Promise<{ readonly id: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const { id } = await ctx.params;
    const view = await getCampaignEditorView(shop, id);
    return view === null ? notFound('Campaign not found.') : Response.json(view);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const { id } = await ctx.params;
    const input = await parseJsonBody<CampaignEditorInput>(request);
    const campaign = await supersedeCampaignForDomain(shop, id, input);
    return campaign === null ? notFound('Campaign not found.') : Response.json(campaign);
  } catch (err) {
    return toErrorResponse(err);
  }
}
