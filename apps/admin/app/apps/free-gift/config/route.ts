// Next.js App Router route exposing the read-only campaign config through the Shopify App Proxy. The
// storefront widget GETs /apps/free-gift/config (same-origin); Shopify forwards it here with the
// signed App Proxy query params. Thin adapter: Request -> ConfigHttpRequest -> handleConfig ->
// Response. All logic lives in src/validate/config* (framework-agnostic, unit-tested).
//
// Node runtime (NOT Edge): the handler needs Prisma and Node crypto for the App Proxy HMAC.
import { getConfigDeps } from '../../../../src/validate/composition.js';
import { handleConfig, type ConfigHttpRequest } from '../../../../src/validate/configHandler.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? '');
  }

  const httpRequest: ConfigHttpRequest = {
    method: 'GET',
    query,
    headers: { 'x-forwarded-for': request.headers.get('x-forwarded-for') ?? undefined },
  };

  const result = await handleConfig(httpRequest, await getConfigDeps());
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}
