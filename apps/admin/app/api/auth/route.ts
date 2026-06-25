// OAuth begin: redirect the merchant to Shopify's authorize screen for the offline-token grant.
// Thin adapter over the 3a buildAuthorizeUrl (via the composition root). Node runtime.
import { OAuthError } from '../../../src/auth/oauth.js';
import { buildInstallRedirect } from '../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const shop = new URL(request.url).searchParams.get('shop');
  if (shop === null) {
    return new Response('Missing ?shop', { status: 400 });
  }
  try {
    return Response.redirect(buildInstallRedirect(shop), 302);
  } catch (error) {
    if (error instanceof OAuthError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
