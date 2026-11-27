import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";

/**
 * The cleanup of a removed account at its provider (Plan 80). The account
 * removal adds this row in its batch, and the provider cleanup runner works
 * it off.
 */
export function prepareProviderAccountCleanup(
  session: Pick<OrganisationDatabaseSession, "prepare">,
  row: Readonly<{
    cleanupId: string;
    organisationId: string;
    integrationAccountId: string;
    provider: string;
    environment: string;
    now: number;
    providerAccountId: string;
    providerConnectionId: string;
    credentialHandles: string;
    providerWebhookIds: string;
    providerContext: string | null;
  }>,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT INTO provider_account_cleanup (
           cleanup_id, organisation_id, integration_account_id, provider, environment,
           lifecycle, reason_code, instruction_code, attempt, next_attempt_at,
           created_at, updated_at, completed_at,
           provider_account_id, provider_connection_id, credential_handles,
           provider_webhook_ids, provider_context
         ) VALUES (?, ?, ?, ?, ?, 'pending_provider_cleanup', NULL, NULL, 0, ?,
           ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.cleanupId,
      row.organisationId,
      row.integrationAccountId,
      row.provider,
      row.environment,
      row.now,
      row.now,
      row.now,
      row.providerAccountId,
      row.providerConnectionId,
      row.credentialHandles,
      row.providerWebhookIds,
      row.providerContext,
    );
}

/**
 * The number of provider cleanups of an Organisation that are not finished:
 * pending, running or waiting for a retry. Zero when the count is not a
 * number.
 */
export async function countOpenProviderAccountCleanups(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS pending
       FROM provider_account_cleanup
       WHERE organisation_id = ?
         AND lifecycle IN (
           'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
         )`,
    )
    .bind(organisationId)
    .first<{ readonly pending: unknown }>();
  return typeof row?.pending === "number" ? row.pending : 0;
}
