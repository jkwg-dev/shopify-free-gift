// Resolve the Online Store publication id at runtime via the Admin API (no build-time env var).
// Matches the Online Store by the system app handle `online_store` on the AppCatalog — robust against
// locale, merchant rename, and display-title changes. Requires `read_publications` scope.
//
// FAIL-FAST, NEVER SILENT. If the Online Store publication cannot be found (channel not installed,
// scope not consented, API error), throws a named MissingPublicationConfigError → 500 + logged on the
// first /config or /validate request. The availability path NEVER silently falls back to a stock-only
// check when the publication id is unknown.

import type { AdminGraphqlClient } from '@free-gift-engine/shopify';

export class MissingPublicationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPublicationConfigError';
  }
}

const ONLINE_STORE_APP_HANDLE = 'online_store';

const PUBLICATIONS_QUERY = `query OnlineStorePublication {
  publications(first: 20, catalogType: APP) {
    nodes {
      id
      catalog {
        ... on AppCatalog {
          apps(first: 1) { nodes { handle } }
        }
      }
    }
  }
}`;

type PublicationNode = {
  readonly id: string;
  readonly catalog?: {
    readonly apps?: { readonly nodes: readonly { readonly handle: string }[] };
  } | null;
};

type PublicationsResponse = {
  readonly publications: { readonly nodes: readonly PublicationNode[] };
};

// Resolve the Online Store publication id from the shop's publications. Boot-eager: called once in the
// singleton constructor (getValidateDeps / getConfigDeps) and cached in memory for the process lifetime.
// Throws MissingPublicationConfigError if the Online Store is not found — same loud-fail behavior as the
// old env-var validation, but now the id adapts automatically per shop (no env change / no redeploy).
export async function resolveOnlineStorePublicationId(client: AdminGraphqlClient): Promise<string> {
  let data: PublicationsResponse;
  try {
    data = await client.request<PublicationsResponse>(PUBLICATIONS_QUERY, {});
  } catch (err) {
    throw new MissingPublicationConfigError(
      'Failed to query publications — cannot resolve the Online Store publication id. ' +
        `Is read_publications consented on this shop? (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  for (const node of data.publications.nodes) {
    const handle = node.catalog?.apps?.nodes[0]?.handle;
    if (handle === ONLINE_STORE_APP_HANDLE) {
      return node.id;
    }
  }

  throw new MissingPublicationConfigError(
    "Online Store publication not found in this shop's publications " +
      '(is the Online Store sales channel installed and read_publications consented?). ' +
      `Searched ${data.publications.nodes.length} APP-type publications for app handle "${ONLINE_STORE_APP_HANDLE}".`,
  );
}

// The scope Product.publishedOnPublication needs — read_products alone is NOT sufficient (ground-truthed
// against the prod token's ACCESS_DENIED). When the granted scopes (from the OAuth token exchange, stored
// on the Shop row) lack it, the channel read degrades to stock-only until the merchant re-consents.
export const READ_PUBLICATIONS_SCOPE = 'read_publications';

export function hasPublicationsScope(grantedScopes: string): boolean {
  return grantedScopes
    .split(',')
    .map((s) => s.trim())
    .includes(READ_PUBLICATIONS_SCOPE);
}
