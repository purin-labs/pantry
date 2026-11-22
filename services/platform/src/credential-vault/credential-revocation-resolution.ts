import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationEnvironment } from "../data/control-plane";
import type { IntegrationProvider } from "../data/integration-account";
import type { IntegrationAccountId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle } from "./service";

type CredentialRevocationResolutionError =
  VaultResolveError | { readonly code: "credential_revocation_scope_inactive" };

export async function resolveCredentialRevocationSecret(
  input: Readonly<{
    db: OrganisationDatabase;
    keys: CredentialVaultBindings;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    provider: IntegrationProvider;
    environment: OrganisationEnvironment;
    providerAccountId: string;
    providerConnectionId: string;
    handle: VaultHandle;
  }>,
): Promise<Result<VaultSecret, CredentialRevocationResolutionError>> {
  const authorized = await input.db
    .prepare(
      `SELECT account.integration_account_id AS integrationAccountId
     FROM integration_account AS account
     JOIN provider_connection AS connection
       ON connection.provider_connection_id = account.provider_connection_id
     WHERE account.organisation_id = ? AND account.integration_account_id = ?
       AND account.provider = ? AND account.environment = ?
       AND account.provider_account_id = ? AND account.provider_connection_id = ?
       AND connection.credential_ref = ?
       AND account.lifecycle != 'revoked' AND connection.lifecycle != 'revoked'
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.provider,
      input.environment,
      input.providerAccountId,
      input.providerConnectionId,
      input.handle,
    )
    .first<{ readonly integrationAccountId: unknown }>();
  if (authorized?.integrationAccountId !== input.integrationAccountId) {
    return {
      ok: false,
      error: { code: "credential_revocation_scope_inactive" },
    };
  }
  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
  });
}
