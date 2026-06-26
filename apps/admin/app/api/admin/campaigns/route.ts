// Embedded admin API: the campaign collection.
//   GET  /api/admin/campaigns  — the read-only campaign list (Phase 3b Stage A).
//   POST /api/admin/campaigns  — create an INACTIVE draft campaign (Phase 3b Stage B).
// AUTH: the App Bridge session token (Bearer JWT), verified server-side via authenticateShop. This
// is a DIFFERENT boundary from the App-Proxy routes (/validate, /config), which keep their own HMAC
// and are untouched. Node runtime (needs node crypto for the JWT + Prisma).
import { campaignListRows } from '../../../../src/admin/campaignList.js';
import {
  authenticateShop,
  parseJsonBody,
  toErrorResponse,
} from '../../../../src/admin/routeHelpers.js';
import type { CampaignEditorInput } from '../../../../src/admin/editorTypes.js';
import {
  createCampaignDraft,
  listCampaignsByDomain,
} from '../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const campaigns = await listCampaignsByDomain(shop);
    return Response.json({ campaigns: campaignListRows(campaigns, new Date()) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const shop = authenticateShop(request);
    const input = await parseJsonBody<CampaignEditorInput>(request);
    const campaign = await createCampaignDraft(shop, input);
    return Response.json(campaign, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
