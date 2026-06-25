// OAuth callback: verify the HMAC, exchange the code for an offline token, encrypt it, and persist
// the install to the Shop row. Thin adapter over the 3a handleOAuthCallback. Node runtime.
import { handleOAuthCallback, OAuthError } from '../../../../src/auth/oauth.js';
import { getOAuthCallbackDeps } from '../../../../src/validate/composition.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    query[key] = value;
  }
  try {
    const shop = await handleOAuthCallback(query, getOAuthCallbackDeps());
    // No embedded UI yet (Phase 3b) — a plain confirmation is enough for the install-link flow.
    return new Response(
      `Free Gift Engine installed for ${shop.domain}. You can close this window.`,
      {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      },
    );
  } catch (error) {
    if (error instanceof OAuthError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
