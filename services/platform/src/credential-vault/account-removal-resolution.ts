import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { IntegrationProvider } from "../data/integration-account";
import type { IntegrationAccountId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle } from "./service";

export type AccountRemovalResolutionError =
  VaultResolveError | { readonly code: "account_removal_scope_inactive" };

export async function resolveAccountRemovalCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly cleanupId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly providerConnectionId: string;
  readonly handle: VaultHandle;
}): Promise<Result<VaultSecret, AccountRemovalResolutionError>> {
  const active = await input.db
    .prepare(
      `SELECT cleanup.cleanup_id AS cleanupId
       FROM provider_account_cleanup AS cleanup
       WHERE cleanup.cleanup_id = ?
         AND cleanup.organisation_id = ?
         AND cleanup.integration_account_id = ?
         AND cleanup.provider = ?
         AND cleanup.environment = ?
         AND cleanup.provider_account_id = ?
         AND cleanup.provider_connection_id = ?
         AND cleanup.lifecycle IN (
           'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
         )
         AND EXISTS (
           SELECT 1
           FROM json_each(cleanup.credential_handles)
           WHERE json_each.value = ?
         )
       LIMIT 1`,
    )
    .bind(
      input.cleanupId,
      input.organisationId,
      input.integrationAccountId,
      input.provider,
      input.environment,
      input.providerAccountId,
      input.providerConnectionId,
      input.handle,
    )
    .first<{ readonly cleanupId: unknown }>();

  if (active?.cleanupId !== input.cleanupId) {
    return { ok: false, error: { code: "account_removal_scope_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
  });
}
