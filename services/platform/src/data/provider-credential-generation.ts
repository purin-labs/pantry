// The table `provider_credential_generation` holds one row for each
// credential that a provider connection had. This module owns each write of
// it (Refactor 17). Another module puts a statement into its own batch.
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
 * Adds an active credential generation of a provider connection. With
 * `ifAbsent`, a generation that exists stays as it is.
 */
export function prepareActiveCredentialGeneration(
  db: Database,
  input: Readonly<{
    providerConnectionId: string;
    credentialGeneration: number;
    organisationId: string;
    provider: string;
    environment: string;
    credentialRef: string;
    createdAt: number;
    activatedAt: number;
    ifAbsent?: boolean;
  }>,
): D1PreparedStatement {
  const conflict =
    input.ifAbsent === true
      ? " ON CONFLICT (provider_connection_id, credential_generation) DO NOTHING"
      : "";
  return db
    .prepare(
      `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)${conflict}`,
    )
    .bind(
      input.providerConnectionId,
      input.credentialGeneration,
      input.organisationId,
      input.provider,
      input.environment,
      input.credentialRef,
      input.createdAt,
      input.activatedAt,
    );
}

/**
 * Supersedes the active generation of a connection. With `credentialRef`,
 * only a generation that holds that credential.
 */
export function prepareCredentialGenerationSupersession(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    providerConnectionId: string;
    credentialGeneration: number;
    credentialRef?: string;
  }>,
): D1PreparedStatement {
  if (input.credentialRef !== undefined) {
    return db
      .prepare(
        `UPDATE provider_credential_generation
           SET lifecycle = 'superseded', superseded_at = ?
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND credential_generation = ? AND credential_ref = ?
             AND lifecycle = 'active'`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.providerConnectionId,
        input.credentialGeneration,
        input.credentialRef,
      );
  }
  return db
    .prepare(
      `UPDATE provider_credential_generation
         SET lifecycle = 'superseded', superseded_at = ?
         WHERE organisation_id = ? AND provider_connection_id = ?
           AND credential_generation = ? AND lifecycle = 'active'`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.providerConnectionId,
      input.credentialGeneration,
    );
}

/** Revokes the active and superseded generations of a connection that a cleanup ended. */
export function prepareCleanedConnectionGenerationsRevocation(
  db: Database,
  input: Readonly<{ now: number; providerConnectionId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation
         SET lifecycle = 'revoked', revoked_at = ?
         WHERE provider_connection_id = ? AND lifecycle IN ('active', 'superseded')`,
    )
    .bind(input.now, input.providerConnectionId);
}

/** Revokes the superseded generations of a connection after a credential cutover. */
export function prepareSupersededGenerationsRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    providerConnectionId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation
       SET lifecycle = 'revoked',
           revoked_at = COALESCE(revoked_at, ?),
           superseded_at = COALESCE(superseded_at, ?)
       WHERE organisation_id = ? AND provider_connection_id = ?
         AND lifecycle = 'superseded'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.providerConnectionId,
    );
}

/** Revokes the generations of the connection of a removed account. */
export function prepareRemovedConnectionGenerationsRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    providerConnectionId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation
           SET lifecycle = 'revoked', revoked_at = ?, superseded_at = NULL
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND lifecycle IN ('active', 'superseded')`,
    )
    .bind(input.now, input.organisationId, input.providerConnectionId);
}

/** Revokes every live generation of an archived Organisation, under the guard. */
export function prepareArchivedOrganisationGenerationsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; guard: RowGuard }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation
         SET lifecycle = 'revoked', revoked_at = ?
         WHERE organisation_id = ? AND lifecycle IN ('active', 'superseded') AND ${input.guard.sql}`,
    )
    .bind(input.now, input.organisationId, ...input.guard.bindings);
}

/** Revokes the live generations that hold a revoked credential. */
export function prepareCredentialHandleGenerationsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; handle: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation
         SET lifecycle = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE organisation_id = ? AND credential_ref = ?
           AND lifecycle IN ('active', 'superseded')`,
    )
    .bind(input.now, input.organisationId, input.handle);
}

/** Revokes the generations of the connection of a disconnected account. */
export function prepareDisconnectedAccountGenerationsRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    integrationAccountId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_credential_generation SET lifecycle = 'revoked', revoked_at = ?
         WHERE organisation_id = ? AND provider_connection_id IN (
           SELECT provider_connection_id FROM integration_account
           WHERE organisation_id = ? AND integration_account_id = ?
         ) AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.organisationId,
      input.integrationAccountId,
    );
}

/** The purge deletes the custom generations and revokes the handle of the others. */
export function prepareOrganisationPurgeCredentialGenerations(
  context: OrganisationPurgeContext,
): D1PreparedStatement[] {
  return [
    purgeGuarded(
      context,
      `DELETE FROM provider_credential_generation
       WHERE organisation_id = ? AND provider_connection_id IN (
         SELECT provider_connection_id FROM provider_connection
         WHERE source_kind = 'custom_api'
       )`,
    ),
    ...context.connections.map((connection) =>
      context.session
        .prepare(
          `UPDATE provider_credential_generation SET credential_ref = ?
           WHERE provider_connection_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `vault:archived:${connection.id}:revoked`,
          connection.id,
          ...context.purged.bindings,
        ),
    ),
  ];
}
