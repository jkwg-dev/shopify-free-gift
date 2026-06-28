// Shared helpers for the embedded admin API routes (Phase 3b). One place for the JWT auth boundary
// and the typed-error -> ApiError mapping, so every /api/admin/* handler stays a thin adapter and
// they all reject identically. The App-Proxy routes (/validate, /config) do NOT use any of this —
// they keep their own HMAC.
import type { ApiError } from '../contract.js';
import { SessionTokenError } from '../security/sessionToken.js';
import { getAdminSessionConfig } from '../validate/composition.js';
import { AnotherCampaignActiveError, ActivationMintError } from '../services/activation.js';
import { CampaignValidationError } from '../services/campaign.js';
import { GiftProvisioningError } from '../services/giftLifecycle.js';
import { ActiveCampaignNotEditableError, CampaignConfigError } from './campaignValidation.js';
import { EditorParseError } from './editorMapping.js';
import { shopFromBearer } from './session.js';

// Verify the App Bridge session token (Bearer JWT) and return the shop domain. Throws
// SessionTokenError (mapped to 401 by toErrorResponse).
export function authenticateShop(request: Request): string {
  return shopFromBearer(request.headers.get('authorization'), getAdminSessionConfig());
}

function apiError(
  status: number,
  code: ApiError['error']['code'],
  message: string,
  invalid?: readonly string[],
): Response {
  const body: ApiError = {
    error: invalid === undefined ? { code, message } : { code, message, invalid },
  };
  return Response.json(body, { status });
}

// Map a thrown error to the uniform ApiError envelope. Unknown errors are re-thrown so Next returns a
// 500 (and the failure is logged) rather than being masked as a client error.
export function toErrorResponse(err: unknown): Response {
  if (err instanceof SessionTokenError) {
    return apiError(401, 'UNAUTHORIZED', 'Invalid or missing session token.');
  }
  if (err instanceof CampaignConfigError) {
    return apiError(400, 'VALIDATION', err.message);
  }
  if (err instanceof EditorParseError) {
    return apiError(400, 'VALIDATION', err.message);
  }
  if (err instanceof CampaignValidationError) {
    return apiError(400, 'VALIDATION', err.message, err.invalidVariantIds);
  }
  if (err instanceof ActiveCampaignNotEditableError) {
    return apiError(400, 'VALIDATION', err.message);
  }
  if (err instanceof AnotherCampaignActiveError) {
    return apiError(400, 'VALIDATION', err.message);
  }
  // Activation provisioning/mint failures (Stage C2): the campaign stayed inactive; surface the
  // precise cause (e.g. which gift variant couldn't mint) so the merchant can fix it.
  if (err instanceof GiftProvisioningError) {
    return apiError(400, 'VALIDATION', err.message);
  }
  if (err instanceof ActivationMintError) {
    return apiError(
      400,
      'VALIDATION',
      err.message,
      err.failures.flatMap((f) => f.variantIds),
    );
  }
  throw err;
}

export function notFound(message = 'Not found.'): Response {
  return apiError(404, 'NOT_FOUND', message);
}

// Parse a JSON request body; throws EditorParseError (-> 400) on malformed JSON.
export async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new EditorParseError('body', 'Request body must be valid JSON.');
  }
}
