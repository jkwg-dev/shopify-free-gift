import { describe, expect, it } from 'vitest';
import type { ApiError } from '../contract.js';
import { SessionTokenError } from '../security/sessionToken.js';
import { ActivationWindowError, ReplaceConfirmationRequiredError } from '../services/activation.js';
import { CampaignValidationError } from '../services/campaign.js';
import { ActiveCampaignNotEditableError, CampaignConfigError } from './campaignValidation.js';
import { EditorParseError } from './editorMapping.js';
import { notFound, toErrorResponse } from './routeHelpers.js';

async function body(res: Response): Promise<ApiError> {
  return (await res.json()) as ApiError;
}

describe('toErrorResponse', () => {
  it('maps a session-token failure to 401 UNAUTHORIZED (the JWT boundary on writes)', async () => {
    const res = toErrorResponse(new SessionTokenError('bad'));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe('UNAUTHORIZED');
  });

  it('maps a config error to 400 VALIDATION', async () => {
    const res = toErrorResponse(
      new CampaignConfigError([
        { code: 'no-tiers', message: 'A campaign needs at least one tier.' },
      ]),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('VALIDATION');
  });

  it('maps an editor parse error to 400 VALIDATION', async () => {
    const res = toErrorResponse(new EditorParseError('amount', 'bad'));
    expect(res.status).toBe(400);
  });

  it('maps a dead-variant error to 400 VALIDATION with the invalid ids', async () => {
    const res = toErrorResponse(new CampaignValidationError(['gid://v/dead']));
    expect(res.status).toBe(400);
    expect((await body(res)).error.invalid).toEqual(['gid://v/dead']);
  });

  it('maps editing an active campaign to 400 VALIDATION', async () => {
    const res = toErrorResponse(new ActiveCampaignNotEditableError('c1'));
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('VALIDATION');
  });

  it('maps a replace-confirmation to 409 CONFIRM_REQUIRED with requiresConfirmation', async () => {
    const res = toErrorResponse(new ReplaceConfirmationRequiredError('c2', 'Smoke Test'));
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe('CONFIRM_REQUIRED');
    expect(b.error.requiresConfirmation).toBe(true);
  });

  it('maps an ended-window activation to 400 VALIDATION', async () => {
    const res = toErrorResponse(new ActivationWindowError(new Date('2026-01-01T00:00:00Z')));
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('VALIDATION');
  });

  it('re-throws unknown errors (so they surface as 500, not a masked 4xx)', () => {
    expect(() => toErrorResponse(new Error('boom'))).toThrow('boom');
  });
});

describe('notFound', () => {
  it('returns 404 NOT_FOUND', async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe('NOT_FOUND');
  });
});
