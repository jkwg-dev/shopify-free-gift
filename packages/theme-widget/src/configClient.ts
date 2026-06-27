// Thin client for the read-only campaign-config endpoint (Phase 5b-2). GETs the same-origin App
// Proxy path with the market query params (currency, country); Shopify signs the forwarded request
// (the client never signs). Returns the parsed CampaignConfigResponse. Separate from the /validate
// client — config is fetched once on load to render the chooser; /validate runs per cart change.
import type { CampaignConfigRequest, CampaignConfigResponse } from '@free-gift-engine/core';

export const DEFAULT_CONFIG_PATH = '/apps/free-gift/config';

export type ConfigClientResponse =
  | { readonly ok: true; readonly config: CampaignConfigResponse }
  | { readonly ok: false; readonly httpStatus: number };

export type GetConfigOptions = {
  readonly fetchFn?: typeof fetch;
  readonly configPath?: string;
};

export async function getConfig(
  request: CampaignConfigRequest,
  options: GetConfigOptions = {},
): Promise<ConfigClientResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const path = options.configPath ?? DEFAULT_CONFIG_PATH;
  const params = new URLSearchParams({
    currency: request.presentmentCurrency,
    country: request.countryCode,
  });
  // Shopify's market FX rate (base -> presentment); the server derives the presentment threshold from
  // it. Signed-as-forwarded by the App Proxy like the other params.
  if (request.presentmentRate !== undefined) {
    params.set('rate', request.presentmentRate);
  }

  const response = await fetchFn(`${path}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return { ok: false, httpStatus: response.status };
  }
  const body: unknown = await response.json();
  return { ok: true, config: body as CampaignConfigResponse };
}
