import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { storeOrganisationPlacementVaultSecret } from "../../credential-vault/service";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import {
  completeProviderProvisioning,
  failProviderAttempt,
  providerAttemptWire,
  recordProviderProvisioningPhase,
  type ProviderConnectionAttempt,
  type ProvisioningProviderConnectionAttempt,
  type ProviderFailureEvidence,
  type ProviderManifestEvidence,
} from "../../data/provider-attempt";
import {
  finalizeConnectedIntegrationAccount,
  integrationAccountAllowsCredentialMutation,
  providerConnectionAllowsCredentialMutation,
  requireConnectionCredentialAuthority,
  resolveIntegrationAccount,
  resolveProviderConnection,
  type createConnectedIntegration,
} from "../../data/integration-account";
import type { Env } from "@purin-labs/kernel/env";
import type {
  ProviderConnectionId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  activateProviderCredentialCutover,
  type ProviderCredentialCutoverError,
} from "./credential-cutover";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import {
  parseVaultHandle,
  type VaultHandle,
  type VaultOAuthTokens,
} from "../../credential-vault";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CompleteProviderInput,
  OnboardingProvider,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "./provider-lifecycle";
import { encodeBase64Url } from "@purin-labs/std";

export async function advanceProviderPhase(
  input: CompleteProviderInput,
  attempt: ProvisioningProviderConnectionAttempt,
  phase: typeof attempt.provisioningPhase,
  receipt: Readonly<Record<string, unknown>>,
  nextPhase: typeof attempt.provisioningPhase,
): Promise<ProvisioningProviderConnectionAttempt> {
  const advanced = await recordProviderProvisioningPhase({
    scope: input.scope,
    attempt,
    phase,
    receipt,
    nextPhase,
    now: input.now,
  });
  if (!advanced.ok) {
    throw new Error(
      `provider provisioning phase advance failed: ${advanced.error.code}`,
    );
  }
  return advanced.value;
}

export async function finishProviderCompletion(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  attempt: ProvisioningProviderConnectionAttempt,
  connectionId: Parameters<
    typeof completeProviderProvisioning
  >[0]["connectionId"],
  integrationAccountIds: Parameters<
    typeof completeProviderProvisioning
  >[0]["integrationAccountIds"],
  manifestEvidence: ProviderManifestEvidence,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  const completed = await completeProviderProvisioning({
    manifestDatabase: input.env.DB,
    scope: input.scope,
    attempt,
    connectionId,
    integrationAccountIds,
    manifestEvidence,
    receipt: {
      connection_id: connectionId,
      integration_account_ids: integrationAccountIds,
      account_count: integrationAccountIds.length,
    },
    portalSubjectHash: authorization.state.portalSubjectHash,
    now: input.now,
  });
  if (!completed.ok) {
    return { ok: false, error: completed.error };
  }
  return {
    ok: true,
    value: {
      provider: completed.value.provider,
      attempt: providerAttemptWire(completed.value),
      returnPath: authorization.state.returnPath,
    },
  };
}

/**
 * The end of a provider connection after its phases: the account becomes
 * active, the new credential replaces the old one, and the attempt completes
 * with this manifest evidence.
 */
export async function finalizeProviderConnection(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  current: ProvisioningProviderConnectionAttempt,
  connected: Awaited<ReturnType<typeof createConnectedIntegration>>,
  manifestEvidence: ProviderManifestEvidence,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  const organisationId = authorization.state.attempt.organisationId;
  const finalized = await finalizeConnectedIntegrationAccount({
    db: input.scope.database,
    organisationId,
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
    organisationId,
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
    manifestEvidence,
  );
}

export async function failProviderCompletion(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  attempt: ProvisioningProviderConnectionAttempt,
  error: ProviderOnboardingError,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  return failProviderCompletionWithEvidence(
    input,
    authorization,
    attempt,
    error,
    providerFailureEvidence(error),
  );
}

export async function failProviderCompletionWithEvidence(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
  attempt: ProvisioningProviderConnectionAttempt,
  error: ProviderOnboardingError,
  providerEvidence: ProviderFailureEvidence,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  const failed = await failProviderAttempt({
    scope: input.scope,
    attempt,
    reasonCode: providerFailureReason(error),
    retryable: providerFailureRetryable(error),
    providerEvidence,
    portalSubjectHash: authorization.state.portalSubjectHash,
    now: input.now,
  });
  return failed.ok
    ? {
        ok: true,
        value: {
          provider: failed.value.provider,
          attempt: providerAttemptWire(failed.value),
          returnPath: authorization.state.returnPath,
        },
      }
    : { ok: false, error: failed.error };
}

function providerFailureReason(error: ProviderOnboardingError): string {
  switch (error.code) {
    case "organisation_placement_missing":
    case "organisation_placement_corrupt":
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "invalid_organisation_placement":
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
      return "provider_temporarily_unavailable";
    case "provider_configuration_missing":
      return "provider_distribution_disabled";
    case "provider_context_invalid":
    case "provider_state_invalid":
    case "provider_state_replayed":
    case "provider_callback_signature_invalid":
      return "provider_state_invalid";
    case "authorization_expired":
      return "authorization_expired";
    case "provider_oauth_denied":
      return "authorization_cancelled";
    case "provider_oauth_exchange_failed":
      return error.status === 429
        ? "provider_rate_limited"
        : "provider_temporarily_unavailable";
    case "provider_oauth_response_invalid":
    case "provider_account_ineligible":
      return "provider_account_ineligible";
    case "provider_scope_missing":
      return "provider_scope_missing";
    case "provider_asset_missing":
      return "provider_asset_missing";
    case "provider_environment_mismatch":
      return "provider_environment_mismatch";
    case "provider_credential_store_failed":
      return "credential_verification_failed";
    case "provider_policy_activation_failed":
      return "provider_policy_activation_failed";
    case "provider_webhook_registration_failed":
      return "provider_webhook_registration_failed";
    case "provider_initial_sync_failed":
      return "provider_initial_sync_failed";
    case "provider_account_already_assigned":
      return "provider_account_already_claimed";
    case "provider_identity_unverified":
      return "provider_identity_unverified";
    case "provider_mailbox_identity_claimed":
      return "provider_account_already_claimed";
    case "provider_attempt_open":
    case "provider_attempt_not_found":
    case "provider_attempt_terminal":
    case "provider_attempt_state_conflict":
    case "configuration_version_conflict":
      return error.code;
  }
}

function providerFailureEvidence(
  error: ProviderOnboardingError,
): ProviderFailureEvidence {
  switch (error.code) {
    case "provider_oauth_exchange_failed":
      return {
        redactedProviderStatus: String(error.status),
        redactedProviderRequestId: error.requestId,
      };
    default:
      return emptyProviderFailureEvidence();
  }
}

function emptyProviderFailureEvidence(): ProviderFailureEvidence {
  return { redactedProviderStatus: null, redactedProviderRequestId: null };
}

function providerFailureRetryable(error: ProviderOnboardingError): boolean {
  switch (error.code) {
    case "organisation_placement_missing":
    case "organisation_placement_corrupt":
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "invalid_organisation_placement":
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
      return true;
    case "provider_oauth_exchange_failed":
      return error.status === 429 || error.status >= 500;
    case "provider_credential_store_failed":
    case "provider_policy_activation_failed":
    case "provider_webhook_registration_failed":
    case "provider_initial_sync_failed":
    case "provider_configuration_missing":
    case "provider_attempt_state_conflict":
      return true;
    case "provider_context_invalid":
    case "provider_attempt_open":
    case "provider_attempt_not_found":
    case "provider_attempt_terminal":
    case "provider_state_invalid":
    case "provider_state_replayed":
    case "authorization_expired":
    case "configuration_version_conflict":
    case "provider_oauth_denied":
    case "provider_oauth_response_invalid":
    case "provider_account_ineligible":
    case "provider_asset_missing":
    case "provider_scope_missing":
    case "provider_environment_mismatch":
    case "provider_callback_signature_invalid":
    case "provider_account_already_assigned":
    case "provider_identity_unverified":
    case "provider_mailbox_identity_claimed":
      return false;
  }
}

export async function verifyExistingAccountIdentity(
  db: OrganisationDatabase,
  attempt: ProviderConnectionAttempt,
  provider: OnboardingProvider,
  providerAccountId: string,
): Promise<Result<true, ProviderOnboardingError>> {
  if (attempt.existingIntegrationAccountId === null) {
    return { ok: true, value: true };
  }
  const account = await resolveIntegrationAccount({
    db,
    organisationId: attempt.organisationId,
    integrationAccountId: attempt.existingIntegrationAccountId,
  });
  if (!account.ok || attempt.purpose === "connect") {
    return { ok: false, error: { code: "provider_account_ineligible" } };
  }
  const connection = await resolveProviderConnection({
    db,
    organisationId: attempt.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  return account.value.provider === provider &&
    account.value.environment === attempt.environment &&
    account.value.providerAccountId === providerAccountId &&
    integrationAccountAllowsCredentialMutation(
      account.value.lifecycle,
      attempt.purpose,
    ) &&
    connection.ok &&
    providerConnectionAllowsCredentialMutation(
      connection.value.lifecycle,
      attempt.purpose,
    )
    ? { ok: true, value: true }
    : { ok: false, error: { code: "provider_account_ineligible" } };
}

function randomOpaqueValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(bytes);
}

export async function storeBearerCredential(
  env: Env,
  scope: OrganisationExecutionScope,
  handle: VaultHandle,
  value: string,
  now: number,
): Promise<Result<true, ProviderOnboardingError>> {
  const stored = await storeOrganisationPlacementVaultSecret({
    scope,
    keys: env,

    handle,
    secret: { kind: "bearer", value },
    now,
  });
  if (!stored.ok) {
    return { ok: false, error: { code: "provider_credential_store_failed" } };
  }
  return { ok: true, value: true };
}

export async function storeOAuthCredential(
  env: Env,
  scope: OrganisationExecutionScope,
  handle: VaultHandle,
  tokens: VaultOAuthTokens,
  now: number,
): Promise<Result<true, ProviderOnboardingError>> {
  const stored = await storeOrganisationPlacementVaultSecret({
    scope,
    keys: env,

    handle,
    secret: tokens,
    now,
  });
  return stored.ok
    ? { ok: true, value: true }
    : { ok: false, error: { code: "provider_credential_store_failed" } };
}

export async function storeHeaderCredential(
  env: Env,
  scope: OrganisationExecutionScope,
  handle: VaultHandle,
  header: string,
  value: string,
  now: number,
): Promise<Result<true, ProviderOnboardingError>> {
  const stored = await storeOrganisationPlacementVaultSecret({
    scope,
    keys: env,

    handle,
    secret: { kind: "header", header, value },
    now,
  });
  if (!stored.ok) {
    return { ok: false, error: { code: "provider_credential_store_failed" } };
  }
  return { ok: true, value: true };
}

export async function completeProviderCredentialCutover(
  input: CompleteProviderInput,
  organisationId: OrganisationId,
  providerConnectionId: ProviderConnectionId,
  credentialGeneration: number,
): Promise<Result<true, ProviderCredentialCutoverError>> {
  if (credentialGeneration === 1) {
    return { ok: true, value: true };
  }

  try {
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env: input.env,
      placement: input.scope.placement,
      organisationId,
      now: input.now,
    });
    return activateProviderCredentialCutover({
      db: input.scope.database,
      kv: input.env.POLICY_KV,
      organisation,
      organisationId,
      providerConnectionId,
      now: input.now,
    });
  } catch {
    return { ok: false, error: { code: "provider_policy_activation_failed" } };
  }
}

export function providerCredentialHandle(
  organisationId: OrganisationId,
  provider: OnboardingProvider,
  accountId: string,
  now: number,
): VaultHandle {
  return requireVaultHandle(
    `vault:${organisationId.toLowerCase()}:${provider}:${slug(accountId)}:oauth:${credentialVersion(now)}`,
  );
}

export function providerSigningHandle(
  organisationId: OrganisationId,
  provider: OnboardingProvider,
  accountId: string,
  now: number,
): VaultHandle {
  return requireVaultHandle(
    `vault:${organisationId.toLowerCase()}:${provider}:${slug(accountId)}:webhook:${credentialVersion(now)}`,
  );
}

function credentialVersion(now: number): string {
  return `${now}-${slug(randomOpaqueValue()).slice(0, 12)}`;
}

function requireVaultHandle(raw: string): VaultHandle {
  const parsed = parseVaultHandle(raw);
  if (!parsed.ok) {
    throw new Error("generated vault handle is invalid");
  }
  return parsed.value;
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}
