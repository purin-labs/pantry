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
