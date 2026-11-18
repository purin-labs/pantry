import {
  OrganisationExecutionScope,
  type OrganisationExecutionScopeError,
} from "../organisation-execution-scope";
import {
  resolveActiveProviderAccountContext,
  type ProviderAccountContextError,
} from "../data/integration-account";
import type { Env } from "../env";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  resolveActiveProviderConnectionCredential,
  type ProviderActionResolutionError,
  type VaultResolveError,
  type VaultSecret,
} from "../credential-vault";

export type StripeExecutionError =
  | OrganisationExecutionScopeError
  | VaultResolveError
  | ProviderActionResolutionError
  | ProviderAccountContextError
  | { code: "stripe_integration_account_invalid" };

export async function resolveStripeWriteCredential(input: {
  env: Env;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
}): Promise<Result<VaultSecret, StripeExecutionError>> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!execution.ok) return execution;
  const context = await resolveActiveProviderAccountContext({
    db: execution.value.database,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });

  if (!context.ok) {
    return context;
  }

  if (context.value.account.provider !== "stripe") {
    return { ok: false, error: { code: "stripe_integration_account_invalid" } };
  }

  const credential = await resolveActiveProviderConnectionCredential({
    db: execution.value.database,
    keys: input.env,
    context: context.value,
    expectedProvider: "stripe",
  });

  if (!credential.ok) {
    return credential.error.code === "provider_connection_scope_inactive"
      ? { ok: false, error: { code: "provider_connection_inactive" } }
      : { ok: false, error: credential.error };
  }

  return credential;
}
