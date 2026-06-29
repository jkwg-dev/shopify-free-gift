// The Online Store publication id used by the Stage-E availability check. Isolated in its own module
// (no heavy imports) so the fail-fast validation is unit-testable without the composition root.
//
// FAIL-FAST, NEVER SILENT. A missing/empty/malformed value must be OBVIOUS, not invisible — this is the
// same class of trap as the FGE_GIFTS_INCLUDED miss, where the app silently took the wrong path because
// the env var was unset. So the availability path NEVER falls back to a stock-only predicate when the id
// is absent: it throws a named MissingPublicationConfigError, which surfaces as a 500 on /config +
// /validate (loud, logged, widget visibly stops) rather than quietly skipping the publication signal.

export class MissingPublicationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPublicationConfigError';
  }
}

// Online Store publication GIDs look like gid://shopify/Publication/<numeric id>.
const PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/\d+$/;

export const ONLINE_STORE_PUBLICATION_ENV = 'SHOPIFY_ONLINE_STORE_PUBLICATION_ID';

// Read + validate the Online Store publication id, throwing a NAMED error if missing/empty/malformed.
// env is injectable for tests; defaults to process.env. The production id DIFFERS from dev's — it must
// be looked up and set per environment (see docs/phase-3b-stage-e-channel-availability-design.md §5a).
export function requireOnlineStorePublicationId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[ONLINE_STORE_PUBLICATION_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    throw new MissingPublicationConfigError(
      `${ONLINE_STORE_PUBLICATION_ENV} is not set — the Online-Store publish availability check cannot run. ` +
        'Set it to the Online Store publication GID (gid://shopify/Publication/<id>) in this environment. ' +
        'It is NOT inferred and must NEVER be skipped (that would silently fall back to a stock-only check).',
    );
  }
  const id = raw.trim();
  if (!PUBLICATION_GID.test(id)) {
    throw new MissingPublicationConfigError(
      `${ONLINE_STORE_PUBLICATION_ENV} is malformed (${id}); expected gid://shopify/Publication/<digits>.`,
    );
  }
  return id;
}
