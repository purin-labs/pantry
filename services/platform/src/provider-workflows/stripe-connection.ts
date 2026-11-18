import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
  upsertProviderWebhook,
} from "../data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "../data/provider-attempt";
import { persistProviderResourceSnapshot } from "../data/provider-resource";
import {
  discoverStripeAccount,
  exchangeStripeAuthorizationCode,
  stripeConnectWebhookConfiguration,
  stripeCredentialEnvironment,
  stripeOnboardingAdapter,
  verifyStripeConnectWebhook,
} from "../provider-adapters/stripe";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../provider-lifecycle/domain";
import {
  advanceProviderPhase,
  completeProviderCredentialCutover,
  failProviderCompletion,
  finishProviderCompletion,
  providerCredentialHandle,
  providerSigningHandle,
  storeBearerCredential,
  storeHeaderCredential,
  verifyExistingAccountIdentity,
} from "../provider-lifecycle/provisioning";
import type { Result } from "../result";
import { linkStripePaymentAccount } from "../commerce/stripe-link";
import { resolveCommerceMerchant } from "../commerce/square-link";

export async function connectStripe(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  const clientSecret = input.env.STRIPE_CONNECT_CLIENT_SECRET;
  if (clientSecret === undefined) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  // The platform key decides the Stripe mode, so a test-mode platform also
  // serves a production organisation while Pantry runs on Stripe test data.
  const stripeMode = stripeCredentialEnvironment(clientSecret);
  if (stripeMode === null) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  const sharedWebhook = stripeConnectWebhookConfiguration(input.env);
  if (!sharedWebhook.ok) {
    return failProviderCompletion(input, attempt, current, sharedWebhook.error);
  }
  const webhookVerified = await verifyStripeConnectWebhook({
    fetcher: input.fetcher,
    webhook: sharedWebhook.value,
    clientSecret,
    environment: stripeMode,
  });
  if (!webhookVerified.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      webhookVerified.error,
    );
  }
  const token = await exchangeStripeAuthorizationCode({
    clientSecret,
    code,
    fetcher: input.fetcher,
  });
  if (!token.ok) {
    return failProviderCompletion(input, attempt, current, token.error);
  }
  if (!scopesAreComplete(stripeOnboardingAdapter, [token.value.scope])) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  if (stripeCredentialEnvironment(token.value.accessToken) !== stripeMode) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_environment_mismatch",
    });
  }
  const account = await discoverStripeAccount({
    fetcher: input.fetcher,
    accountId: token.value.accountId,
    accessToken: token.value.accessToken,
    environment: stripeMode,
  });
  if (!account.ok) {
    return failProviderCompletion(input, attempt, current, account.error);
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "stripe",
    token.value.accountId,
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
      provider_subject_id: token.value.accountId,
      platform_mode: stripeMode === "production" ? "live" : "test",
      country: account.value.country,
      active_capabilities: account.value.activeCapabilities,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "stripe",
    token.value.accountId,
    input.now,
  );
  const stored = await storeBearerCredential(
    input.env,
    input.scope,
    credentialRef,
    token.value.accessToken,
    input.now,
  );
  if (!stored.ok) {
    return failProviderCompletion(input, attempt, current, stored.error);
  }
  const signingSecretRef = providerSigningHandle(
    base.organisationId,
    "stripe",
    sharedWebhook.value.id,
    input.now,
  );
  const signingStored = await storeHeaderCredential(
    input.env,
    input.scope,
    signingSecretRef,
    "stripe-signing-secret",
    sharedWebhook.value.secret,
    input.now,
  );
  if (!signingStored.ok) {
    return failProviderCompletion(input, attempt, current, signingStored.error);
  }
  current = await advanceProviderPhase(
    input,
    current,
    "persisting_credential",
    {
      credential_ref: credentialRef,
      signing_secret_ref: signingSecretRef,
      credential_verified: true,
    },
    "discovering_accounts",
  );
  const connected = await createConnectedIntegration(input.scope.database, {
    organisationId: base.organisationId,
    provider: "stripe",
    providerSubjectId: token.value.accountId,
    environment: base.environment,
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: [token.value.scope],
    createdByUserId: base.userId,
    providerAccountId: token.value.accountId,
    accountKind: "merchant_account",
    displayName: account.value.displayName,
    capabilities: ["payments.read", "refunds.propose", "refunds.execute"],
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
  await upsertProviderWebhook({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: "stripe",
    environment: base.environment,
    providerNativeId: sharedWebhook.value.id,
    eventType: "commerce_events",
    signingSecretRef,
    credentialGeneration: requireConnectionCredentialAuthority(
      connected.connection,
    ).credentialGeneration,
    lifecycle: { kind: "live", lastVerifiedAt: input.now },
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      platform_webhook_id: sharedWebhook.value.id,
      account_scoped_webhook_created: false,
    },
    "discovering_resources",
  );
  const snapshotRevision = await persistProviderResourceSnapshot({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: "stripe",
    environment: base.environment,
    resources: [
      {
        canonicalResourceId: token.value.accountId,
        providerResourceId: token.value.accountId,
        providerAccountId: token.value.accountId,
        displayLabel: token.value.accountId,
        accessState: "accessible",
        providerRevision: `stripe-account:${token.value.accountId}`,
        resourceKind: "merchant_account",
      },
    ],
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      account_summary_discovered: true,
      snapshot_revision: snapshotRevision,
      resource_count: 1,
    },
    "verifying_connection",
  );
  current = await advanceProviderPhase(
    input,
    current,
    "verifying_connection",
    {
      provider_identity_verified: true,
      platform_webhook_verified: true,
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
  // A Pantry commerce merchant's Stripe payments run in Commerce; a failed
  // link is tried again by the next provider check.
  const merchant = await resolveCommerceMerchant(
    input.env,
    input.scope,
    base.organisationId,
  );
  if (merchant !== null) {
    await linkStripePaymentAccount(
      merchant,
      base.organisationId,
      token.value.accountId,
    );
  }
  return finishProviderCompletion(
    input,
    attempt,
    current,
    connected.connection.providerConnectionId,
    [finalized.value.integrationAccountId],
    { kind: "healthy", evidenceCode: "provider_webhook_verified" },
  );
}

function scopesAreComplete(
  adapter: Readonly<{
    requiredScopes: readonly string[];
    scopeIsGranted: (
      requiredScope: string,
      grantedScopes: ReadonlySet<string>,
    ) => boolean;
  }>,
  grantedScopes: readonly string[],
): boolean {
  const granted = new Set(grantedScopes);
  return adapter.requiredScopes.every((requiredScope) =>
    adapter.scopeIsGranted(requiredScope, granted),
  );
}
