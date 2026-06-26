// Embedded admin API: GET /api/admin/campaigns — the read-only campaign list (Phase 3b Stage A).
// AUTH: the App Bridge session token (Bearer JWT), verified server-side via shopFromBearer. This is a
// DIFFERENT boundary from the App-Proxy routes (/validate, /config), which keep their own HMAC and are
// untouched. Node runtime (needs node crypto for the JWT + Prisma). Thin adapter over the composition
// root + the pure list view-model.
import { campaignListRows } from '../../../../src/admin/campaignList.js';
import { shopFromBearer } from '../../../../src/admin/session.js';
import { SessionTokenError } from '../../../../src/security/sessionToken.js';
import {
  getAdminSessionConfig,
  listCampaignsByDomain,
} from '../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let shop: string;
  try {
    shop = shopFromBearer(request.headers.get('authorization'), getAdminSessionConfig());
  } catch (err) {
    if (err instanceof SessionTokenError) {
      return new Response('Unauthorized', { status: 401 });
    }
    throw err;
  }
  const campaigns = await listCampaignsByDomain(shop);
  return Response.json({ campaigns: campaignListRows(campaigns, new Date()) });
}
