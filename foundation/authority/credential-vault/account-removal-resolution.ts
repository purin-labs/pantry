import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { IntegrationProvider } from "@purin-labs/connections/data/integration-account";
import type { IntegrationAccountId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { integrationCredentialReads } from "./integration-reads";
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
  const active = await integrationCredentialReads
    .use()
    .accountRemovalCleanupHoldsHandle(input.db, {
      cleanupId: input.cleanupId,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      provider: input.provider,
      environment: input.environment,
      providerAccountId: input.providerAccountId,
      providerConnectionId: input.providerConnectionId,
      handle: input.handle,
    });

  if (!active) {
    return { ok: false, error: { code: "account_removal_scope_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
  });
}
