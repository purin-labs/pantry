// Reads of one integration account that the control routes make.

type Database = Pick<D1Database, "prepare">;

/** Why the account left the active state, or null. */
export async function readIntegrationAccountReasonCode(
  db: Database,
  organisationId: string,
  integrationAccountId: string,
): Promise<string | null | undefined> {
  const row = await db
    .prepare(
      `SELECT lifecycle_reason_code AS reasonCode FROM integration_account
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{ readonly reasonCode: string | null }>();
  return row?.reasonCode;
}

/** When the account's active credential generation was authorized, or null. */
export async function readActiveCredentialAuthorizedAt(
  db: Database,
  organisationId: string,
  integrationAccountId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT generation.created_at AS authorizedAt
       FROM provider_credential_generation AS generation
       JOIN integration_account AS account
         ON account.provider_connection_id = generation.provider_connection_id
      WHERE account.organisation_id = ? AND account.integration_account_id = ?
        AND generation.lifecycle = 'active'
      ORDER BY generation.credential_generation DESC
      LIMIT 1`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{ readonly authorizedAt: number }>();
  return row === null ? null : row.authorizedAt;
}
