// The writes of the table `provider_connection` that other modules put into
// their own batch (Refactor 17: only the owner of a table writes it). Each
// statement keeps the text and the values of the site that it came from.
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import {
  purgeGuarded,
  type OrganisationPurgeContext,
} from "@purin-labs/tenancy/data/organisation-lifecycle-port";
import type { RowGuard } from "@purin-labs/tenancy/data/shared-rows/organisation-row";

type Database = OrganisationDatabase | OrganisationDatabaseSession;

/**
 * Adds the connection of a new custom connector account from its verified
 * setup attempt. It adds no row unless the attempt, the approved revision,
 * the connector, the configuration version and the candidate credential
 * still agree.
 */
export function prepareCustomConnectorConnectionInsert(
  db: Database,
  input: Readonly<{
    providerConnectionId: string;
    createdByUserId: string;
    now: number;
    expectedConfigurationVersion: number;
    organisationId: string;
    attemptId: string;
    attemptRevision: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO provider_connection (
             provider_connection_id, organisation_id, source_kind, custom_connector_id,
             provider, auth_mode, authority_kind, credential_generation,
             credential_ref, lifecycle, granted_scopes,
             created_by_user_id, created_at, updated_at,
             disabled_at, revoked_at, environment, provider_subject_id
           )
           SELECT ?, setup.organisation_id, 'custom_api', setup.connector_id,
             'custom_api', 'api_key', 'connection_credential', 1,
             setup.candidate_credential_ref, 'active', '[]', ?, ?, ?,
             NULL, NULL, setup.environment, setup.verified_provider_account_id
           FROM custom_connector_setup_attempt AS setup
           JOIN custom_connector_revision AS revision
             ON revision.organisation_id = setup.organisation_id
            AND revision.connector_id = setup.connector_id
            AND revision.revision = setup.connector_revision
            AND revision.definition_digest = setup.definition_digest
           JOIN custom_connector AS connector
             ON connector.organisation_id = setup.organisation_id
            AND connector.connector_id = setup.connector_id
           JOIN organisation_onboarding AS onboarding
             ON onboarding.organisation_id = setup.organisation_id
            AND onboarding.configuration_version = ?
           JOIN vault_secret AS secret
             ON secret.organisation_id = setup.organisation_id
            AND secret.vault_handle = setup.candidate_credential_ref
            AND secret.revoked_at IS NULL
           WHERE setup.organisation_id = ? AND setup.attempt_id = ?
             AND setup.lifecycle = 'verified' AND setup.attempt_revision = ?
             AND setup.expires_at > ? AND revision.review_state = 'approved'
             AND connector.lifecycle IN ('draft', 'active')`,
    )
    .bind(
      input.providerConnectionId,
      input.createdByUserId,
      input.now,
      input.now,
      input.expectedConfigurationVersion,
      input.organisationId,
      input.attemptId,
      input.attemptRevision,
      input.now,
    );
}

/** Moves a custom connector connection to its next credential generation. */
export function prepareCustomConnectorConnectionRotation(
  db: Database,
  input: Readonly<{
    nextCredentialGeneration: number;
    nextCredentialRef: string;
    now: number;
    organisationId: string;
    providerConnectionId: string;
    connectorId: string;
    credentialGeneration: number;
    credentialRef: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
           SET credential_generation = ?, credential_ref = ?, lifecycle = 'active',
               updated_at = ?, disabled_at = NULL, revoked_at = NULL
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND source_kind = 'custom_api' AND custom_connector_id = ?
             AND credential_generation = ? AND credential_ref = ?
             AND lifecycle != 'revoked'`,
    )
    .bind(
      input.nextCredentialGeneration,
      input.nextCredentialRef,
      input.now,
      input.organisationId,
      input.providerConnectionId,
      input.connectorId,
      input.credentialGeneration,
      input.credentialRef,
    );
}

/** Disables the live connections of a custom connector. */
export function prepareCustomConnectorConnectionsDisable(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; connectorId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
         SET lifecycle = 'disabled', disabled_at = ?, updated_at = ?
         WHERE organisation_id = ? AND custom_connector_id = ? AND source_kind = 'custom_api'
           AND lifecycle IN ('active', 'reauth_required')`,
    )
    .bind(input.now, input.now, input.organisationId, input.connectorId);
}

/** Moves an active connection to the next generation of a rotated credential. */
export function prepareConnectionCredentialRotation(
  db: Database,
  input: Readonly<{
    replacementHandle: string;
    now: number;
    organisationId: string;
    providerConnectionId: string;
    credentialGeneration: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
         SET credential_generation = credential_generation + 1,
             credential_ref = ?, updated_at = ?
         WHERE organisation_id = ? AND provider_connection_id = ?
           AND credential_generation = ? AND lifecycle = 'active'`,
    )
    .bind(
      input.replacementHandle,
      input.now,
      input.organisationId,
      input.providerConnectionId,
      input.credentialGeneration,
    );
}

/** Revokes a connection that a provider cleanup ended. */
export function prepareCleanedConnectionRevocation(
  db: Database,
  input: Readonly<{ now: number; providerConnectionId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
         SET lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL, updated_at = ?
         WHERE provider_connection_id = ? AND lifecycle != 'revoked'`,
    )
    .bind(input.now, input.now, input.providerConnectionId);
}

/** Revokes the connection of a removed account. */
export function prepareRemovedConnectionRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    providerConnectionId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
           SET lifecycle = 'revoked', disabled_at = NULL,
               revoked_at = ?, updated_at = ?
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.providerConnectionId,
    );
}

/** Revokes every live connection of an archived Organisation, under the guard. */
export function prepareArchivedOrganisationConnectionsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; guard: RowGuard }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
         SET lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL, updated_at = ?
         WHERE organisation_id = ? AND lifecycle != 'revoked' AND ${input.guard.sql}`,
    )
    .bind(input.now, input.now, input.organisationId, ...input.guard.bindings);
}

/** Revokes the live connections that hold a revoked credential. */
export function prepareCredentialHandleConnectionsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; handle: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
         SET lifecycle = 'revoked', disabled_at = NULL,
             revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE organisation_id = ? AND credential_ref = ? AND lifecycle != 'revoked'`,
    )
    .bind(input.now, input.now, input.organisationId, input.handle);
}

/** Revokes the connection of a disconnected account. */
export function prepareDisconnectedAccountConnectionRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    integrationAccountId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection SET lifecycle = 'revoked', updated_at = ?,
         revoked_at = ?, disabled_at = NULL WHERE organisation_id = ? AND provider_connection_id IN (
           SELECT provider_connection_id FROM integration_account
           WHERE organisation_id = ? AND integration_account_id = ?
         ) AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.organisationId,
      input.integrationAccountId,
    );
}

/**
 * The archive of an Organisation disables each connection that is not
 * disabled or revoked, while the guard holds.
 */
export function prepareArchivedOrganisationConnectionsDisable(
  db: Database,
  input: Readonly<{
    organisationId: string;
    now: number;
    guard: RowGuard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_connection
       SET lifecycle = 'disabled', disabled_at = ?, revoked_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND lifecycle NOT IN ('disabled', 'revoked') AND ${input.guard.sql}`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      ...input.guard.bindings,
    );
}

/** The purge deletes the custom connections and pseudonymizes the others. */
export function prepareOrganisationPurgeConnections(
  context: OrganisationPurgeContext,
): D1PreparedStatement[] {
  return [
    purgeGuarded(
      context,
      "DELETE FROM provider_connection WHERE organisation_id = ? AND source_kind = 'custom_api'",
    ),
    ...context.connections.map((connection) =>
      context.session
        .prepare(
          // A shared-application connection has no organisation credential to
          // pseudonymize, and its authority branch requires the handle to stay
          // null, so only the organisation-credential branch is rewritten.
          `UPDATE provider_connection
           SET provider_subject_id = ?,
               credential_ref = CASE
                 WHEN authority_kind = 'connection_credential' THEN ?
                 ELSE NULL
               END,
               lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL,
               updated_at = ?
           WHERE provider_connection_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `archived:${connection.providerSubjectHash}`,
          `vault:archived:${connection.id}:revoked`,
          context.now,
          context.now,
          connection.id,
          ...context.purged.bindings,
        ),
    ),
  ];
}
