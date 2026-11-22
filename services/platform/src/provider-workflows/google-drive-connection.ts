import { storeOrganisationPlacementVaultSecret } from "@purin-labs/authority/credential-vault/service";
import {
  resolveProviderManifestCredential,
  type VaultOAuthTokens,
} from "@purin-labs/authority/credential-vault/index";
import type { ProviderManifestEvidence } from "@purin-labs/connections/data/provider-attempt";
import { createConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "@purin-labs/connections/data/provider-attempt";
import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  pkceChallenge,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "@purin-labs/connections/provider-adapters/authorization";
import {
  createGoogleDriveAuthorizationUrl,
  exchangeGoogleDriveAuthorizationCode,
  GOOGLE_DRIVE_REQUIRED_SCOPES,
  readGoogleDriveIdentity,
  refreshGoogleDriveAccessToken,
  revokeGoogleDriveToken,
  type GoogleDriveProtocolError,
} from "../provider-adapters/google-drive";
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
  failProviderCompletion,
  providerCredentialHandle,
  storeOAuthCredential,
  verifyExistingAccountIdentity,
} from "../integrations/contract/provisioning";
import { finishProviderManagedConnection } from "./provider-managed-connection";
import type { Result } from "@purin-labs/kernel/result";

const GOOGLE_DRIVE_MANUAL_INSTRUCTION =
  "revoke_google_drive_access_in_google" as const;

export const googleDriveCleanupAdapter: ProviderCleanupAdapter<"google_drive"> =
  {
    provider: "google_drive",
    manualActionInstruction: GOOGLE_DRIVE_MANUAL_INSTRUCTION,
    remove: removeGoogleDriveConnection,
  };

export const googleDriveOnboardingAdapter: ProviderOnboardingAdapter<"google_drive"> =
  {
    provider: "google_drive",
    requiredScopes: GOOGLE_DRIVE_REQUIRED_SCOPES,
    stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
    parseStartContext: parseGoogleDriveStartContext,
    configurationIsValid: googleDriveConfigurationIsValid,
    authorizationSecret: googleDriveAuthorizationSecret,
    authorizationUrl: googleDriveAuthorizationUrl,
    scopeIsGranted: exactScopeIsGranted,
  };

export async function connectGoogleDrive(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = authorization.state.attempt;
  const clientId = configuredValue(input.env.GDRIVE_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(input.env.GDRIVE_OAUTH_CLIENT_SECRET);
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
  const exchanged = await exchangeGoogleDriveAuthorizationCode({
    configuration: { clientId, clientSecret },
    code,
    redirectUri: providerCallbackUri(input.env, "google_drive"),
    pkceVerifier,
    fetcher: input.fetcher,
  });
  if (!exchanged.ok) {
    return failProviderCompletion(
      input,
      authorization,
      current,
      googleDriveOnboardingError(exchanged.error),
    );
  }
  if (!scopesComplete(GOOGLE_DRIVE_REQUIRED_SCOPES, exchanged.value.scopes)) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_scope_missing",
    });
  }
  const identity = await readGoogleDriveIdentity({
    accessToken: exchanged.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok) {
    return failProviderCompletion(input, authorization, current, {
      code: "provider_identity_unverified",
    });
  }
  const existingIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "google_drive",
    identity.value.permissionId,
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
      provider_subject_id: identity.value.permissionId,
      scope_count: exchanged.value.scopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "google_drive",
    identity.value.permissionId,
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
    provider: "google_drive",
    providerSubjectId: identity.value.permissionId,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: exchanged.value.scopes,
    createdByUserId: base.userId,
    providerAccountId: identity.value.permissionId,
    accountKind: "resource",
    displayName: identity.value.email,
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  return finishProviderManagedConnection(
    input,
    authorization,
    current,
    connected,
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

function googleDriveOnboardingError(
  error: GoogleDriveProtocolError,
): ProviderOnboardingError {
  return error.code === "gdrive_http_rejected"
    ? {
        code: "provider_oauth_exchange_failed",
        status: error.status,
        requestId: null,
      }
    : { code: "provider_oauth_response_invalid" };
}

export async function observeGoogleDriveConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const tokens = await resolveGoogleDriveObservationTokens(input);
  if (tokens === null) {
    return blockedEvidence("provider_credential_unavailable");
  }
  const configuration = googleDriveConfiguration(input.env);
  if (configuration === null) {
    return blockedEvidence("provider_configuration_missing");
  }
  const refreshed = await refreshGoogleDriveAccessToken({
    configuration,
    refreshToken: tokens.refreshToken,
    scopes: GOOGLE_DRIVE_REQUIRED_SCOPES,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) {
    return blockedEvidence("provider_identity_unverified");
  }
  const identity = await readGoogleDriveIdentity({
    accessToken: refreshed.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok || identity.value.permissionId !== input.providerAccountId) {
    return blockedEvidence("provider_identity_unverified");
  }
  const now = Date.now();
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.env,

    handle: requireCredentialRef(input),
    secret: oauthTokens(
      refreshed.value.accessToken,
      refreshed.value.refreshToken,
      now + refreshed.value.expiresInSeconds * 1_000,
    ),
    now,
  });
  return stored.ok
    ? { kind: "healthy", evidenceCode: "provider_identity_verified" }
    : blockedEvidence("provider_credential_unavailable");
}

function parseGoogleDriveStartContext(
  raw: unknown,
): { readonly provider: "google_drive" } | null {
  return parseProviderOnlyStartContext("google_drive", raw);
}

function googleDriveConfigurationIsValid(
  env: Parameters<
    ProviderOnboardingAdapter<"google_drive">["configurationIsValid"]
  >[0],
): boolean {
  return googleDriveConfiguration(env) !== null;
}

function googleDriveAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"google_drive">["authorizationSecret"]
  >[0],
): string | null {
  return configuredValue(env.GDRIVE_OAUTH_CLIENT_SECRET);
}

async function googleDriveAuthorizationUrl(
  input: Parameters<
    ProviderOnboardingAdapter<"google_drive">["authorizationUrl"]
  >[0],
): Promise<string> {
  if (input.pkceVerifier === null) {
    throw new Error("Google Drive PKCE verifier is missing");
  }
  return createGoogleDriveAuthorizationUrl({
    clientId: input.configuration.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    pkceChallenge: await pkceChallenge(input.pkceVerifier),
  });
}

async function removeGoogleDriveConnection(
  input: Parameters<ProviderCleanupAdapter<"google_drive">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const tokens = input.credentials.oauthTokens;
  if (tokens === null) {
    return permanentCleanupFailure("provider_cleanup_credential_missing");
  }
  const revoked = await revokeGoogleDriveToken({
    token: tokens.refreshToken,
    fetcher: input.fetcher,
  });
  return revoked.ok
    ? { kind: "removed" }
    : googleDriveCleanupError(revoked.error);
}

async function resolveGoogleDriveObservationTokens(
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
    provider: "google_drive",
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
    throw new Error("Google Drive credential reference is missing");
  }
  return input.credentialRef;
}

function googleDriveConfiguration(
  env: Pick<
    Parameters<
      ProviderOnboardingAdapter<"google_drive">["configurationIsValid"]
    >[0],
    "GDRIVE_OAUTH_CLIENT_ID" | "GDRIVE_OAUTH_CLIENT_SECRET"
  >,
): { readonly clientId: string; readonly clientSecret: string } | null {
  const clientId = configuredValue(env.GDRIVE_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(env.GDRIVE_OAUTH_CLIENT_SECRET);
  return clientId === null || clientSecret === null
    ? null
    : { clientId, clientSecret };
}

function googleDriveCleanupError(
  error: GoogleDriveProtocolError,
): ProviderCleanupResult {
  if (error.code === "gdrive_http_rejected") {
    return providerHttpFailure(error.status, GOOGLE_DRIVE_MANUAL_INSTRUCTION);
  }
  return error.retryable
    ? { kind: "retryable_failure", reason: "provider_cleanup_http_unavailable" }
    : permanentCleanupFailure("provider_cleanup_response_invalid");
}

function permanentCleanupFailure(
  reason:
    "provider_cleanup_credential_missing" | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return {
    kind: "permanent_failure",
    reason,
    instruction: GOOGLE_DRIVE_MANUAL_INSTRUCTION,
  };
}

function blockedEvidence(reasonCode: string): ProviderManifestEvidence {
  return { kind: "blocked", reasonCode, repairActions: ["reconnect_provider"] };
}
