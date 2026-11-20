// The statements that revoke a stored secret or a credential reference. The
// Vault owns the tables `vault_secret` and `credential_ref`. Another module
// puts one of these statements into its own batch, so that its change and the
// revocation happen together.

import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";

type Database = OrganisationDatabase | OrganisationDatabaseSession;

/** A condition that the statement joins with AND, and its values. */
type Guard = Readonly<{ sql: string; bindings: readonly unknown[] }>;

/** Marks the secret of a handle as revoked. A revoked secret keeps its time. */
export function prepareVaultSecretRevocation(
  db: Database,
  input: Readonly<{ organisationId: string; handle: string; now: number }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret SET revoked_at = ?
       WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.organisationId, input.handle);
}

/** Marks the secret of a handle as revoked while the guard holds. */
export function prepareGuardedVaultSecretRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    handle: string;
    guard: Guard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret SET revoked_at = ? WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL AND ${input.guard.sql}`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.handle,
      ...input.guard.bindings,
    );
}

/**
 * Revokes each live secret of an archived Organisation, apart from the
 * shared handles (a JSON array), while the guard holds.
 */
export function prepareArchivedOrganisationSecretsRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    sharedHandles: string;
    guard: Guard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret SET revoked_at = ?
         WHERE organisation_id = ? AND revoked_at IS NULL
           AND vault_handle NOT IN (SELECT value FROM json_each(?)) AND ${input.guard.sql}`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.sharedHandles,
      ...input.guard.bindings,
    );
}

/** Revokes the secrets of the superseded generations of a connection. */
export function prepareSupersededGenerationSecretsRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    providerConnectionId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE organisation_id = ?
         AND vault_handle IN (
           SELECT credential_ref
           FROM provider_credential_generation
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND lifecycle = 'superseded'
         )`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.organisationId,
      input.providerConnectionId,
    );
}

/** Points the live credential reference of a provider at its rotated handle. */
export function prepareCredentialRefRotation(
  db: Database,
  input: Readonly<{
    replacementHandle: string;
    organisationId: string;
    provider: string;
    handle: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credential_ref
         SET vault_handle = ?
         WHERE organisation_id = ? AND provider = ? AND vault_handle = ?
           AND revoked_at IS NULL`,
    )
    .bind(
      input.replacementHandle,
      input.organisationId,
      input.provider,
      input.handle,
    );
}

/** Marks the live credential reference of a handle as revoked. */
export function prepareCredentialRefRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; handle: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credential_ref SET revoked_at = ?
         WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.organisationId, input.handle);
}

/** Revokes each live credential reference of an archived Organisation while the guard holds. */
export function prepareArchivedOrganisationCredentialRefsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; guard: Guard }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credential_ref SET revoked_at = ?
         WHERE organisation_id = ? AND revoked_at IS NULL AND ${input.guard.sql}`,
    )
    .bind(input.now, input.organisationId, ...input.guard.bindings);
}

/**
 * Revokes the token of the surface installation of an account when a repeat
 * install replaces it with another token, while the guard holds.
 */
export function prepareReplacedSurfaceTokenRevocation(
  db: Database,
  input: Readonly<{
    installedAt: number;
    organisationId: string;
    integrationAccountId: string;
    botTokenRef: string;
    guard: Guard;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret
       SET revoked_at = ?
       WHERE organisation_id = ?
         AND vault_handle = (
           SELECT bot_token_ref
           FROM surface_installation
           WHERE integration_account_id = ?
         )
         AND vault_handle <> ?
         AND revoked_at IS NULL AND ${input.guard.sql}`,
    )
    .bind(
      input.installedAt,
      input.organisationId,
      input.integrationAccountId,
      input.botTokenRef,
      ...input.guard.bindings,
    );
}
