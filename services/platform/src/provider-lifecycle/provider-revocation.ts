// A provider that tells Pantry it removed Pantry's access (Refactor 15): Shopify's
// `app/uninstalled` and Stripe's `account.application.deauthorized`. The
// account goes through the same credential revocation as an operator's
// revoke: the account, its connection and its webhooks are revoked, the
// Vault secret is revoked, and the revocation's policy is published, so no
// later call sends the dead token. A repeated event changes nothing.
import { revokeCredential } from "../credential-vault";
import { activateRevocationPolicy } from "../control/credential-revocation-policy";
import {
  resolveIntegrationAccount,
  resolveProviderConnection,
  type IntegrationProvider,
} from "../data/integration-account";
import type { Env } from "../env";
import { newRequestId, type IntegrationAccountId } from "../ids";
import { traceLog, traceWarn } from "../observability";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import {
  prepareConfigurationVersionBump,
} from "../data/organisation-onboarding-row";

type ProviderRevocationReason =
  "shopify_app_uninstalled" | "stripe_application_deauthorized";

type ProviderRevocationOutcome =
  | Readonly<{
      kind: "revoked";
      revocationId: string;
      policy: "active" | "pending";
    }>
  | Readonly<{ kind: "already_revoked" }>;

type ProviderRevocationError = Readonly<{
  code: "integration_account_not_found" | "provider_connection_not_found";
}>;

/**
 * Revokes the account that `provider` names by `providerAccountId`. An
 * account of another provider or another provider account is not found, and
 * nothing changes.
 */
export async function revokeAccountRemovedAtProvider(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    integrationAccountId: IntegrationAccountId;
    provider: IntegrationProvider;
    providerAccountId: string;
    reason: ProviderRevocationReason;
    now: number;
  }>,
): Promise<Result<ProviderRevocationOutcome, ProviderRevocationError>> {
  const organisationId = input.scope.organisationId;
  const db = input.scope.database;
  const account = await resolveIntegrationAccount({
    db,
    organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (
    !account.ok ||
    account.value.provider !== input.provider ||
    account.value.providerAccountId !== input.providerAccountId
  )
    return { ok: false, error: { code: "integration_account_not_found" } };
  const connection = await resolveProviderConnection({
    db,
    organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (!connection.ok) return connection;
  if (
    account.value.lifecycle.kind === "revoked" &&
    connection.value.lifecycle.kind === "revoked"
  )
    return { ok: true, value: { kind: "already_revoked" } };
  const committed = await revokeCredential({
    db,
    organisationId,
    handle: connection.value.authority.credentialRef,
    now: input.now,
  });
  let policy: "active" | "pending" = "active";
  if (committed.state === "committed") {
    const activation = await activateRevocationPolicy(
      input.env,
      input.scope,
      committed,
      Date.now(),
    );
    // The revocation stays committed; the Vault alert names a delayed policy.
    if (!activation.ok) policy = "pending";
  }
  await prepareConfigurationVersionBump(db, organisationId, input.now)
    .run();
  const trace = {
    requestId: newRequestId(),
    organisation_id: organisationId,
    integration_account_id: input.integrationAccountId,
    provider: input.provider,
    reason: input.reason,
    revocation_id: committed.revocationId,
  };
  if (policy === "pending")
    traceWarn("provider_lifecycle.provider_revocation_policy_pending", trace);
  else traceLog("provider_lifecycle.provider_revoked_access", trace);
  return {
    ok: true,
    value: { kind: "revoked", revocationId: committed.revocationId, policy },
  };
}
