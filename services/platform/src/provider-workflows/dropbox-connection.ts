import { storeOrganisationPlacementVaultSecret } from "../credential-vault/service";
import {
  resolveProviderManifestCredential,
  type VaultOAuthTokens,
} from "../credential-vault";
import type { ProviderManifestEvidence } from "../data/provider-attempt";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
} from "../data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "../data/provider-attempt";
import {
  DROPBOX_REQUIRED_SCOPES,
  createDropboxAuthorizationUrl,
  exchangeDropboxAuthorizationCode,
  readDropboxAccount,
  refreshDropboxAccessToken,
  revokeDropboxToken,
  type DropboxProtocolError,
} from "../provider-adapters/dropbox";
import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  pkceChallenge,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "../provider-adapters/authorization";
import {
  providerHttpFailure,
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderObservationRequest,
  type ProviderOnboardingAdapter,
} from "../integrations/contract/provider-adapter";
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
  storeOAuthCredential,
  verifyExistingAccountIdentity,
} from "../integrations/contract/provisioning";
import type { Result } from "../result";

const DROPBOX_MANUAL_INSTRUCTION = "revoke_dropbox_access_in_dropbox" as const;

export const dropboxCleanupAdapter: ProviderCleanupAdapter<"dropbox"> = {
  provider: "dropbox",
  manualActionInstruction: DROPBOX_MANUAL_INSTRUCTION,
  remove: removeDropboxConnection,
};

export const dropboxOnboardingAdapter: ProviderOnboardingAdapter<"dropbox"> = {
  provider: "dropbox",
  requiredScopes: DROPBOX_REQUIRED_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseDropboxStartContext,
  configurationIsValid: dropboxConfigurationIsValid,
  authorizationSecret: dropboxAuthorizationSecret,
  authorizationUrl: dropboxAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

export async function connectDropbox(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = authorization.state.attempt;
  const clientId = configuredValue(input.env.DROPBOX_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(input.env.DROPBOX_OAUTH_CLIENT_SECRET);
  const pkceVerifier = authorization.state.pkceVerifier;
  if (clientId === null || clientSecret === null) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_configuration_missing",
    });
  }
  if (pkceVerifier === null) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_context_invalid",
    });
  }
  const exchanged = await exchangeDropboxAuthorizationCode({
    configuration: { clientId, clientSecret },
    code,
    redirectUri: providerCallbackUri(input.env, "dropbox"),
    pkceVerifier,
    fetcher: input.fetcher,
  });
  if (!exchanged.ok) {
    return failProviderCompletion(
      input,
      authorization,
      current,
      dropboxOnboardingError(exchanged.error),
    );
  }
  if (!scopesComplete(DROPBOX_REQUIRED_SCOPES, exchanged.value.scopes)) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_scope_missing",
    });
  }
  const identity = await readDropboxAccount({
    accessToken: exchanged.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok || identity.value.accountId !== exchanged.value.accountId) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_identity_unverified",
    });
  }
  const existingIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "dropbox",
    identity.value.accountId,
  );
  if (!existingIdentity.ok) {
    return failProviderCompletion(
      input,
      authorization,
      current,
      existingIdentity.error,
    );
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_identity",
    {
      provider_subject_id: identity.value.accountId,
      scope_count: exchanged.value.scopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "dropbox",
    identity.value.accountId,
    input.now,
  );
  const stored = await storeOAuthCredential(
    input.env,
    input.scope,
    credentialRef,
    oauthTokens(
      exchanged.value.accessToken,
      exchanged.value.refreshToken,
      input.now + exchanged.value.expiresInSeconds * 1_000,
    ),
    input.now,
  );
  if (!stored.ok) {
    return failProviderCompletion(input, authorization, current, stored.error);
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
    provider: "dropbox",
    providerSubjectId: identity.value.accountId,
    environment: base.environment,
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: exchanged.value.scopes,
    createdByUserId: base.userId,
    providerAccountId: identity.value.accountId,
    accountKind: "resource",
    displayName: identity.value.displayName,
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  return finishFileProviderConnection(input, authorization, current, connected);
}

async function finishFileProviderConnection(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  connected: Awaited<ReturnType<typeof createConnectedIntegration>>,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = await advanceProviderPhase(
    input,
    provisioning,
    "discovering_accounts",
    {
      integration_account_ids: [connected.account.integrationAccountId],
    },
    "reconciling_webhooks",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      webhook_count: 0,
    },
    "discovering_resources",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      resource_selection_managed_by_provider: true,
    },
    "verifying_connection",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "verifying_connection",
    {
      provider_identity_verified: true,
    },
    "finalizing",
  );
  const finalized = await finalizeConnectedIntegrationAccount({
    db: input.scope.database,
    organisationId: authorization.state.attempt.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    now: input.now,
  });
  if (!finalized.ok) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  const cutover = await completeProviderCredentialCutover(
    input,
    authorization.state.attempt.organisationId,
    connected.connection.providerConnectionId,
    requireConnectionCredentialAuthority(connected.connection)
      .credentialGeneration,
  );
  if (!cutover.ok) {
    return failProviderCompletion(input, authorization, current, cutover.error);
  }
  return finishProviderCompletion(
    input,
    authorization,
    current,
    connected.connection.providerConnectionId,
    [finalized.value.integrationAccountId],
    { kind: "healthy", evidenceCode: "callback_identity_verified" },
  );
}

function oauthTokens(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
): VaultOAuthTokens {
  return {
    kind: "oauth_tokens",
    accessToken,
    refreshToken,
    expiry: { kind: "expires", expiresAt },
  };
}

function scopesComplete(
  required: readonly string[],
  granted: readonly string[],
): boolean {
  const grantedSet = new Set(granted);
  return required.every((scope) => grantedSet.has(scope));
}

function dropboxOnboardingError(
  error: DropboxProtocolError,
): ProviderOnboardingError {
  return error.code === "dropbox_http_rejected"
    ? {
        code: "provider_oauth_exchange_failed",
        status: error.status,
        requestId: null,
      }
    : { code: "provider_oauth_response_invalid" };
}

export async function observeDropboxConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const tokens = await resolveDropboxObservationTokens(input);
  if (tokens === null) {
    return blockedEvidence("provider_credential_unavailable");
  }
  const configuration = dropboxConfiguration(input.env);
  if (configuration === null) {
    return blockedEvidence("provider_configuration_missing");
  }
  const refreshed = await refreshDropboxAccessToken({
    configuration,
    refreshToken: tokens.refreshToken,
    accountId: input.providerAccountId,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) {
    return blockedEvidence("provider_identity_unverified");
  }
  const identity = await readDropboxAccount({
    accessToken: refreshed.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok || identity.value.accountId !== input.providerAccountId) {
    return blockedEvidence("provider_identity_unverified");
  }
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.env,

    handle: requireCredentialRef(input),
    secret: oauthTokens(
      refreshed.value.accessToken,
      refreshed.value.refreshToken,
      Date.now() + refreshed.value.expiresInSeconds * 1_000,
    ),
    now: Date.now(),
  });
  return stored.ok
    ? { kind: "healthy", evidenceCode: "provider_identity_verified" }
    : blockedEvidence("provider_credential_unavailable");
}

function parseDropboxStartContext(
  raw: unknown,
): { readonly provider: "dropbox" } | null {
  return parseProviderOnlyStartContext("dropbox", raw);
}

function dropboxConfigurationIsValid(
  env: Parameters<
    ProviderOnboardingAdapter<"dropbox">["configurationIsValid"]
  >[0],
): boolean {
  return dropboxConfiguration(env) !== null;
}

function dropboxAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"dropbox">["authorizationSecret"]
  >[0],
): string | null {
  return configuredValue(env.DROPBOX_OAUTH_CLIENT_SECRET);
}

async function dropboxAuthorizationUrl(
  input: Parameters<
    ProviderOnboardingAdapter<"dropbox">["authorizationUrl"]
  >[0],
): Promise<string> {
  if (input.pkceVerifier === null) {
    throw new Error("Dropbox PKCE verifier is missing");
  }
  return createDropboxAuthorizationUrl({
    clientId: input.configuration.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    pkceChallenge: await pkceChallenge(input.pkceVerifier),
  });
}

async function removeDropboxConnection(
  input: Parameters<ProviderCleanupAdapter<"dropbox">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const tokens = input.credentials.oauthTokens;
  if (tokens === null) {
    return permanentCleanupFailure("provider_cleanup_credential_missing");
  }
  const configuration = dropboxConfiguration(input.env);
  if (configuration === null) {
    return permanentCleanupFailure("provider_cleanup_configuration_missing");
  }
  const refreshed = await refreshDropboxAccessToken({
    configuration,
    refreshToken: tokens.refreshToken,
    accountId: input.cleanup.providerAccountId,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) {
    return dropboxCleanupError(refreshed.error);
  }
  const revoked = await revokeDropboxToken({
    accessToken: refreshed.value.accessToken,
    fetcher: input.fetcher,
  });
  return revoked.ok ? { kind: "removed" } : dropboxCleanupError(revoked.error);
}

async function resolveDropboxObservationTokens(
  input: ProviderObservationRequest,
): Promise<VaultOAuthTokens | null> {
  if (input.credentialRef === null) {
    return null;
  }
  const credential = await resolveProviderManifestCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider: "dropbox",
    environment: input.environment,
    providerAccountId: input.providerAccountId,
    credentialRef: input.credentialRef,
  });
  return credential.ok && credential.value.kind === "oauth_tokens"
    ? credential.value
    : null;
}

function requireCredentialRef(
  input: ProviderObservationRequest,
): Exclude<ProviderObservationRequest["credentialRef"], null> {
  if (input.credentialRef === null) {
    throw new Error("Dropbox credential reference is missing");
  }
  return input.credentialRef;
}

function dropboxConfiguration(
  env: Pick<
    Parameters<ProviderOnboardingAdapter<"dropbox">["configurationIsValid"]>[0],
    "DROPBOX_OAUTH_CLIENT_ID" | "DROPBOX_OAUTH_CLIENT_SECRET"
  >,
): { readonly clientId: string; readonly clientSecret: string } | null {
  const clientId = configuredValue(env.DROPBOX_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(env.DROPBOX_OAUTH_CLIENT_SECRET);
  return clientId === null || clientSecret === null
    ? null
    : { clientId, clientSecret };
}

function dropboxCleanupError(
  error: DropboxProtocolError,
): ProviderCleanupResult {
  if (error.code === "dropbox_http_rejected") {
    return providerHttpFailure(error.status, DROPBOX_MANUAL_INSTRUCTION);
  }
  return error.retryable
    ? { kind: "retryable_failure", reason: "provider_cleanup_http_unavailable" }
    : permanentCleanupFailure("provider_cleanup_response_invalid");
}

function permanentCleanupFailure(
  reason:
    | "provider_cleanup_configuration_missing"
    | "provider_cleanup_credential_missing"
    | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return {
    kind: "permanent_failure",
    reason,
    instruction: DROPBOX_MANUAL_INSTRUCTION,
  };
}

function blockedEvidence(reasonCode: string): ProviderManifestEvidence {
  return { kind: "blocked", reasonCode, repairActions: ["reconnect_provider"] };
}
