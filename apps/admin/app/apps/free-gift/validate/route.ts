// Next.js App Router route handler exposing /validate through the Shopify App Proxy. The storefront
// posts to /apps/free-gift/validate (same-origin); Shopify forwards it here with the signed App
// Proxy query params. This file is a THIN adapter: Request -> ValidateHttpRequest -> handleValidate
// -> Response. All logic lives in src/validate (framework-agnostic, fully unit-tested).
//
// Node runtime (NOT Edge): the handler needs Prisma and Node crypto for the App Proxy HMAC.
import { getValidateDeps } from '../../../../src/validate/composition.js';
import { handleValidate, type ValidateHttpRequest } from '../../../../src/validate/handler.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? '');
  }

  const httpRequest: ValidateHttpRequest = {
    method: 'POST',
    query,
    headers: { 'x-forwarded-for': request.headers.get('x-forwarded-for') ?? undefined },
    rawBody: await request.text(),
  };

  const result = await handleValidate(httpRequest, getValidateDeps());
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}
