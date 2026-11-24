import { createConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "@purin-labs/connections/data/provider-attempt";
import {
  validateExternalProviderToken,
  type ExternalRecordsProvider,
} from "@purin-labs/connections/external-records/records";
import { exchangeExternalRecordsOAuthCode } from "../external-records/oauth";
import { airtableOnboardingAdapter } from "../provider-adapters/airtable";
import { notionOnboardingAdapter } from "../provider-adapters/notion";
import { providerCallbackUri } from "../provider-lifecycle/authorization";
import type {
  CompleteProviderInput,
  OnboardingProvider,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "@purin-labs/area-integrations-contract/server/provider-lifecycle";
import {
  advanceProviderPhase,
  failProviderCompletion,
  providerCredentialHandle,
  storeOAuthCredential,
  verifyExistingAccountIdentity,
} from "../contract/provisioning";
import { finishProviderManagedConnection } from "./provider-managed-connection";
import { scopesAreComplete } from "@purin-labs/connections/provider-adapters/authorization";
import type { Result } from "@purin-labs/kernel/result";

export async function connectExternalRecordsOAuth(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  const provider = externalRecordsProvider(attempt.context.provider);
  if (provider === null) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_context_invalid",
    });
  }
  const exchanged = await exchangeExternalRecordsOAuthCode({
    env: input.env,
    provider,
    code,
    redirectUri: providerCallbackUri(input.env, provider),
    pkceVerifier: attempt.state.pkceVerifier,
    now: input.now,
    fetcher: input.fetcher,
  });
  if (!exchanged.ok) {
    return failProviderCompletion(input, attempt, current, exchanged.error);
  }
  const identity = await validateExternalProviderToken({
    provider,
    token: exchanged.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  const onboarding =
    provider === "airtable"
      ? airtableOnboardingAdapter
      : notionOnboardingAdapter;
  if (!scopesAreComplete(onboarding, identity.value.grantedScopes)) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    provider,
    identity.value.providerAccountId,
  );
  if (!accountIdentity.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      accountIdentity.error,
    );
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_identity",
    {
      provider_subject_id: identity.value.providerAccountId,
      scope_count: identity.value.grantedScopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    provider,
    identity.value.providerAccountId,
    input.now,
  );
  const stored = await storeOAuthCredential(
    input.env,
    input.scope,
    credentialRef,
    exchanged.value,
    input.now,
  );
  if (!stored.ok) {
    return failProviderCompletion(input, attempt, current, stored.error);
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
    provider,
    providerSubjectId: identity.value.providerAccountId,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: identity.value.grantedScopes,
    createdByUserId: base.userId,
    providerAccountId: identity.value.providerAccountId,
    accountKind: provider === "airtable" ? "user_grant" : "workspace",
    displayName: identity.value.displayName,
    capabilities:
      provider === "airtable"
        ? ["airtable.api.read", "airtable.api.write"]
        : ["notion.search"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  return finishProviderManagedConnection(input, attempt, current, connected);
}

function externalRecordsProvider(
  provider: OnboardingProvider,
): ExternalRecordsProvider | null {
  switch (provider) {
    case "airtable":
    case "notion":
      return provider;
    case "slack":
    case "square":
    case "stripe":
    case "shopify":
    case "gmail":
    case "dropbox":
    case "google_drive":
    case "whatsapp":
      return null;
  }
}
