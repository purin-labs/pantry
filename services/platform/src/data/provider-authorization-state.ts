// The state that a provider's OAuth callback brings back.

type Database = Pick<D1Database, "prepare">;

/** The organisation and return path of the stored state, or null. */
export function readProviderAuthorizationState(
  db: Database,
  stateHash: string,
  provider: string,
): Promise<{
  readonly organisationId: unknown;
  readonly returnPath: unknown;
} | null> {
  return db
    .prepare(
      `SELECT organisation_id AS organisationId, return_path AS returnPath
     FROM provider_authorization_state
     WHERE state_hash = ? AND provider = ?
     LIMIT 1`,
    )
    .bind(stateHash, provider)
    .first<{
      readonly organisationId: unknown;
      readonly returnPath: unknown;
    }>();
}
