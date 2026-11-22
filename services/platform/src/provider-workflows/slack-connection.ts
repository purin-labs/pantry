import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
  upsertSurfaceInstallation,
} from "@purin-labs/connections/data/integration-account";
import {
  newSlackInstallationId,
  newSlackOrganisationConnectionId,
} from "@purin-labs/kernel/ids";
import {
  type ProvisioningProviderConnectionAttempt,
  type ProviderManifestEvidence,
} from "@purin-labs/connections/data/provider-attempt";
import { persistProviderResourceSnapshot } from "@purin-labs/connections/data/provider-resource";
import type { Env } from "@purin-labs/kernel/env";
import {
  discoverSlackChannels,
  exchangeSlackAuthorizationCode,
  slackOnboardingAdapter,
} from "../provider-adapters/slack";
import { providerCallbackUri } from "../provider-lifecycle/authorization";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../integrations/contract/provider-lifecycle";
import {
  advanceProviderPhase,
  completeProviderCredentialCutover,
  failProviderCompletion,
  finishProviderCompletion,
  providerCredentialHandle,
  storeBearerCredential,
  verifyExistingAccountIdentity,
} from "../integrations/contract/provisioning";
import { scopesAreComplete } from "@purin-labs/connections/provider-adapters/authorization";
import type { Result } from "@purin-labs/kernel/result";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import { slackInstallationOwnerIsLive } from "../credential-vault/slack-installation-credential";
import {
  activateSlackInstallation,
  createSlackInstallation,
  createSlackOrganisationConnection,
  disableSlackOrganisationConnection,
  resolveSlackInstallation,
} from "../slack/installation-store";

export async function connectSlack(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  const clientId = input.env.SLACK_CLIENT_ID;
  const clientSecret = input.env.SLACK_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  const installation = await exchangeSlackAuthorizationCode({
    clientId,
    clientSecret,
    code,
    redirectUri: providerCallbackUri(input.env, "slack"),
    fetcher: input.fetcher,
  });
  if (!installation.ok) {
    return failProviderCompletion(input, attempt, current, installation.error);
  }
  const configuredIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: input.env.PANTRY_DEPLOYMENT_PROFILE,
    appId: input.env.SLACK_APP_ID,
  });
  if (
    !configuredIdentity.ok ||
    configuredIdentity.value.environment !== base.environment ||
    configuredIdentity.value.appId !== installation.value.appId
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "slack",
    installation.value.teamId,
  );
  if (!accountIdentity.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      accountIdentity.error,
    );
  }
  if (!scopesAreComplete(slackOnboardingAdapter, installation.value.scopes)) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_identity",
    {
      provider_subject_id: installation.value.teamId,
      bot_user_id: installation.value.botUserId,
      scope_count: installation.value.scopes.length,
    },
    "persisting_credential",
  );
  const physicalInstallation = await resolveSlackInstallation(input.env.DB, {
    environment: base.environment,
    appId: installation.value.appId,
    workspaceId: installation.value.teamId,
  });
  if (physicalInstallation.kind === "corrupt") {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  // The installation owns its bot token in the Vault of an Organisation that
  // uses the workspace. When the owner no longer has an active connection
  // there (it was archived or purged), the connecting Organisation becomes
  // the owner, so no Organisation depends on one that has ended.
  const keepsOwner =
    physicalInstallation.kind === "existing" &&
    (physicalInstallation.credentialOrganisationId === base.organisationId ||
      (await slackInstallationOwnerIsLive(
        input.env.DB,
        physicalInstallation.installationId,
        physicalInstallation.credentialOrganisationId,
      )));
  const credentialOrganisationId =
    physicalInstallation.kind === "existing" && keepsOwner
      ? physicalInstallation.credentialOrganisationId
      : base.organisationId;
  const credentialRef =
    physicalInstallation.kind === "existing" && keepsOwner
      ? physicalInstallation.botTokenRef
      : providerCredentialHandle(
          credentialOrganisationId,
          "slack",
          installation.value.teamId,
          input.now,
        );
  const credentialScope =
    credentialOrganisationId === input.scope.organisationId
      ? { ok: true as const, value: input.scope }
      : await OrganisationExecutionScope.resolve(
          input.env,
          credentialOrganisationId,
        );
  if (!credentialScope.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      credentialScope.error,
    );
  }
  const stored = await storeBearerCredential(
    input.env,
    credentialScope.value,
    credentialRef,
    installation.value.token,
    input.now,
  );
  if (!stored.ok) {
    return failProviderCompletion(input, attempt, current, stored.error);
  }
  const installationId =
    physicalInstallation.kind === "existing"
      ? physicalInstallation.installationId
      : newSlackInstallationId();
  if (physicalInstallation.kind === "available") {
    await createSlackInstallation(input.env.DB, {
      installationId,
      environment: base.environment,
      appId: installation.value.appId,
      workspaceId: installation.value.teamId,
      credentialOrganisationId,
      botTokenRef: credentialRef,
      installModel: "unlisted",
      scopes: installation.value.scopes,
      installedAt: input.now,
    });
  } else {
    const activated = await activateSlackInstallation({
      db: input.env.DB,
      installationId,
      credentialOrganisationId,
      botTokenRef: credentialRef,
      scopes: installation.value.scopes,
      activatedAt: input.now,
    });
    if (!activated) {
      return failProviderCompletion(input, attempt, current, {
        code: "provider_oauth_response_invalid",
      });
    }
  }
  current = await advanceProviderPhase(
    input,
    current,
    "persisting_credential",
    {
      credential_ref: credentialRef,
      credential_verified: true,
    },
    "discovering_accounts",
  );
  const connected = await createConnectedIntegration(input.scope.database, {
    organisationId: base.organisationId,
    provider: "slack",
    providerSubjectId: installation.value.teamId,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: installation.value.scopes,
    createdByUserId: base.userId,
    providerAccountId: installation.value.teamId,
    accountKind: "workspace",
    displayName: installation.value.teamName,
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_accounts",
    {
      integration_account_ids: [connected.account.integrationAccountId],
    },
    "reconciling_webhooks",
  );
  await upsertSurfaceInstallation({
    db: input.scope.database,
    account: connected.account,
    surfaceKind: "slack",
    workspaceId: installation.value.teamId,
    installModel: "unlisted",
    botTokenRef: credentialRef,
    scopes: installation.value.scopes,
    installedAt: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      shared_application_subscription_verified:
        input.env.SLACK_SIGNING_SECRET !== undefined,
    },
    "discovering_resources",
  );
  const resources = await discoverSlackChannels({
    fetcher: input.fetcher,
    accessToken: installation.value.token,
    providerAccountId: installation.value.teamId,
  });
  if (!resources.ok) {
    return failProviderCompletion(input, attempt, current, resources.error);
  }
  const snapshotRevision = await persistProviderResourceSnapshot({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: "slack",
    environment: base.environment,
    resources: resources.value,
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      snapshot_revision: snapshotRevision,
      resource_count: resources.value.length,
    },
    "verifying_connection",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "verifying_connection",
    {
      provider_identity_verified: true,
      required_scopes_verified: true,
    },
    "finalizing",
  );
  const finalized = await finalizeConnectedIntegrationAccount({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    now: input.now,
  });
  if (!finalized.ok) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  await disableSlackOrganisationConnection(input.env.DB, {
    organisationId: base.organisationId,
    integrationAccountId: finalized.value.integrationAccountId,
    now: input.now,
  });
  await createSlackOrganisationConnection(input.env, {
    connectionId: newSlackOrganisationConnectionId(),
    installationId,
    organisationId: base.organisationId,
    integrationAccountId: finalized.value.integrationAccountId,
    connectedAt: input.now,
  });
  const cutover = await completeProviderCredentialCutover(
    input,
    base.organisationId,
    connected.connection.providerConnectionId,
    requireConnectionCredentialAuthority(connected.connection)
      .credentialGeneration,
  );
  if (!cutover.ok) {
    return failProviderCompletion(input, attempt, current, cutover.error);
  }
  return finishProviderCompletion(
    input,
    attempt,
    current,
    connected.connection.providerConnectionId,
    [finalized.value.integrationAccountId],
    slackManifestEvidence(input.env),
  );
}

function slackManifestEvidence(env: Env): ProviderManifestEvidence {
  return env.SLACK_SIGNING_SECRET !== undefined &&
    env.SLACK_SIGNING_SECRET.length > 0
    ? { kind: "healthy", evidenceCode: "provider_webhook_verified" }
    : {
        kind: "blocked",
        reasonCode: "shared_application_subscription_unconfigured",
        repairActions: ["configure_slack_signing_secret"],
      };
}
