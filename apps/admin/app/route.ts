// App entry GET "/" (the Dev Dashboard application_url stays "/"). Branches on install state so an
// install-link / app-open for a not-yet-installed shop enters OAuth begin instead of dead-ending.
// Thin adapter over resolveRootEntry + the composition root's isShopInstalled. Node runtime.
// NOT the Phase 3b embedded admin UI.
import { resolveRootEntry } from '../src/install/rootEntry.js';
import { isShopInstalled } from '../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const shop = new URL(request.url).searchParams.get('shop');
  const result = await resolveRootEntry(shop, { isInstalled: isShopInstalled });

  if (result.kind === 'redirect') {
    return new Response(null, { status: 302, headers: { Location: result.location } });
  }
  return new Response(result.body, {
    status: result.kind === 'bad-request' ? 400 : 200,
    headers: { 'content-type': 'text/plain' },
  });
}
