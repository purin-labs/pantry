import type { GlobalDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
// Slack installation records that the integration routes write and read.

type Database = Pick<D1Database, "prepare">;

/** The integration account of the channel's connection, or null. */
export async function readSlackConnectionIntegrationAccountId(
  db: Database,
  input: Readonly<{
    installationId: string;
    connectionId: string;
    organisationId: string;
  }>,
): Promise<unknown> {
  const row = await db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId
     FROM slack_organisation_connection
     WHERE installation_id = ? AND connection_id = ? AND organisation_id = ?`,
    )
    .bind(input.installationId, input.connectionId, input.organisationId)
    .first<{ readonly integrationAccountId: unknown }>();
  return row?.integrationAccountId;
}

export function prepareSlackDmSelectionAuditEvent(
  db: Database,
  input: Readonly<{
    auditEventId: string;
    installationId: string;
    externalUserId: string;
    connectionId: string;
    revision: number;
    actorUserId: string;
    receiptId: string;
    occurredAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO slack_dm_organisation_selection_audit_event (
           audit_event_id, installation_id, external_user_id, connection_id,
           revision, actor_user_id, idempotency_receipt_id,
           occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.auditEventId,
      input.installationId,
      input.externalUserId,
      input.connectionId,
      input.revision,
      input.actorUserId,
      input.receiptId,
      input.occurredAt,
    );
}

export function prepareSlackInstallationDisconnectAuditEvent(
  db: Database,
  input: Readonly<{
    auditEventId: string;
    installationId: string;
    actorUserId: string;
    receiptId: string;
    occurredAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO slack_installation_audit_event (
           audit_event_id, installation_id, operation,
           actor_user_id, idempotency_receipt_id, occurred_at
         ) VALUES (?, ?, 'installation_wide_disconnect', ?, ?, ?)`,
    )
    .bind(
      input.auditEventId,
      input.installationId,
      input.actorUserId,
      input.receiptId,
      input.occurredAt,
    );
}

/** Records a revocation event of a Slack installation. A repeated event stays as it is. */
export function prepareSlackInstallationLifecycleEvent(
  globalDatabase: Database,
  input: Readonly<{
    eventId: string;
    installationId: string;
    reason: string;
    occurredAt: number;
    recordedAt: number;
  }>,
): D1PreparedStatement {
  return globalDatabase
    .prepare(
      `INSERT OR IGNORE INTO slack_installation_lifecycle_event (
         event_id, installation_id, reason, occurred_at, recorded_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventId,
      input.installationId,
      input.reason,
      input.occurredAt,
      input.recordedAt,
    );
}

/**
 * The directory's Slack records that name the Organisation's connections: a
 * person's DM choice and the thread pins. A DM choice that named a revoked
 * connection asks the person to choose again; a pin has no Case to reach.
 */
export function directorySlackRecordDeletions(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
): readonly (readonly [table: string, statement: D1PreparedStatement])[] {
  return [
    [
      "slack_dm_organisation_selection",
      directory
        .prepare(
          `DELETE FROM slack_dm_organisation_selection
           WHERE EXISTS (SELECT 1 FROM slack_organisation_connection AS connection
             WHERE connection.installation_id = slack_dm_organisation_selection.installation_id
               AND connection.connection_id = slack_dm_organisation_selection.connection_id
               AND connection.organisation_id = ? AND connection.lifecycle = 'revoked')`,
        )
        .bind(organisationId),
    ],
    [
      "slack_thread_case_pin",
      directory
        .prepare("DELETE FROM slack_thread_case_pin WHERE organisation_id = ?")
        .bind(organisationId),
    ],
  ];
}

/** How many of the records that `directorySlackRecordDeletions` deletes exist. */
export function directorySlackRecordCount(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
): D1PreparedStatement {
  return directory
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM slack_dm_organisation_selection AS selection
          JOIN slack_organisation_connection AS connection
            ON connection.installation_id = selection.installation_id
           AND connection.connection_id = selection.connection_id
          WHERE connection.organisation_id = ?1 AND connection.lifecycle = 'revoked')
       + (SELECT COUNT(*) FROM slack_thread_case_pin WHERE organisation_id = ?1) AS count`,
    )
    .bind(organisationId);
}

/** Revokes an installation whose bot token the Organisation holds. */
export function prepareSlackInstallationRevocation(
  directory: GlobalDatabase,
  input: Readonly<{
    installationId: string;
    organisationId: OrganisationId;
    now: number;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `UPDATE slack_installation
           SET lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL, updated_at = ?
           WHERE installation_id = ? AND credential_organisation_id = ?
             AND lifecycle != 'revoked'`,
    )
    .bind(input.now, input.now, input.installationId, input.organisationId);
}

/**
 * Moves the bot token of an installation to the next Organisation, while the
 * installation still names the old holder and its handle.
 */
export function prepareSlackInstallationCredentialMove(
  directory: GlobalDatabase,
  input: Readonly<{
    installationId: string;
    organisationId: OrganisationId;
    botTokenRef: string;
    nextOrganisationId: OrganisationId;
    nextBotTokenRef: string;
    now: number;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `UPDATE slack_installation
         SET credential_organisation_id = ?, bot_token_ref = ?, updated_at = ?
         WHERE installation_id = ? AND credential_organisation_id = ? AND bot_token_ref = ?`,
    )
    .bind(
      input.nextOrganisationId,
      input.nextBotTokenRef,
      input.now,
      input.installationId,
      input.organisationId,
      input.botTokenRef,
    );
}
