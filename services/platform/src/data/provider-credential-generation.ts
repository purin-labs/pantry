// The table `provider_credential_generation` holds one row for each
// credential that a provider connection had. This module owns the insert of a
// new active generation. Another module puts the statement into its own batch.
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";

/**
 * Adds an active credential generation of a provider connection. With
 * `ifAbsent`, a generation that exists stays as it is.
 */
export function prepareActiveCredentialGeneration(
  db: OrganisationDatabase | OrganisationDatabaseSession,
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
