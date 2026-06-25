// Thin /validate client for the storefront widget (Phase 5a). Posts the cart + choices + decline to
// the App Proxy path (same-origin) and parses the discriminated result. The client does NOT sign —
// Shopify signs app-proxy requests on the way to our app. Deliberately separate from the pure
// reconciler (which takes the parsed result as input). No retry / cart-event logic yet — that's 5b.
import type { ValidateError, ValidateRequest, ValidateResult } from '@free-gift-engine/core';

// Same-origin App Proxy path (prefix `apps`, subpath `free-gift`). Shopify forwards it to /validate.
export const DEFAULT_PROXY_PATH = '/apps/free-gift/validate';

export type ValidateClientResponse =
  | { readonly ok: true; readonly result: ValidateResult }
  | { readonly ok: false; readonly httpStatus: number; readonly error: ValidateError['error'] };

export type PostValidateOptions = {
  // Injected for tests; defaults to the global fetch. (Seam — no real cart wiring here.)
  readonly fetchFn?: typeof fetch;
  readonly proxyPath?: string;
};

export async function postValidate(
  request: ValidateRequest,
  options: PostValidateOptions = {},
): Promise<ValidateClientResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const path = options.proxyPath ?? DEFAULT_PROXY_PATH;

  const response = await fetchFn(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      error: (body as ValidateError).error,
    };
  }
  return { ok: true, result: body as ValidateResult };
}
