import {
  linkSquarePaymentLocations,
  readSquareDelegation,
  readCommerceSquareConnection,
  resolveCommerceMerchant,
  squareDelegationSecret,
  type SquareDelegation,
} from "../commerce/contract/square-link";
import { storeOrganisationPlacementVaultSecret } from "../credential-vault/service";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
} from "@purin-labs/connections/data/integration-account";
import type {
  ProvisioningProviderConnectionAttempt,
  ProviderManifestEvidence,
} from "@purin-labs/connections/data/provider-attempt";
import { persistProviderResourceSnapshot } from "@purin-labs/connections/data/provider-resource";
import {
  resolveProviderManifestCredential,
  type VaultHandle,
} from "../credential-vault";
import {
  advanceProviderPhase,
  completeProviderCredentialCutover,
  failProviderCompletion,
  finishProviderCompletion,
  providerCredentialHandle,
  verifyExistingAccountIdentity,
} from "../integrations/contract/provisioning";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../integrations/contract/provider-lifecycle";
import {
  readSquareConfiguration,
  squareOnboardingAdapter,
} from "../provider-adapters/square";
import type { ProviderObservationRequest } from "../integrations/contract/provider-adapter";
import type { Result } from "@purin-labs/kernel/result";

/**
 * Complete a Square merchant connection.
 *
 * The connection carries payment authority only: its granted scopes exclude
 * Orders, Catalog, Inventory, and Customers, so Pantry stays the sole commerce
 * authority. Commerce exchanges the code and holds the tokens (Plan 80
 * step 4); Pantry's credential is a delegation record without a token.
 */
export async function connectSquare(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  const configuration = readSquareConfiguration(input.env);
  if (
    configuration.kind !== "configured" ||
    configuration.application.environment !== base.environment
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  // Commerce exchanges the code with the Square application's secret and
  // keeps the tokens; Pantry keeps only the merchant that holds them.
  const square = await resolveCommerceMerchant(
    input.env,
    input.scope,
    base.organisationId,
  );
  if (square === null) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_account_ineligible",
    });
  }
  const connected = await square.client.connectSquare(square.merchantId, {
    environment: base.environment,
    grant: { kind: "authorization_code", code },
  });
  if (!connected.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      connected.error.kind === "http" && connected.error.status === 409
        ? {
            code: "provider_oauth_exchange_failed",
            status: connected.error.status,
            requestId: null,
          }
        : { code: "provider_oauth_response_invalid" },
    );
  }
  const seller = connected.value;
  const displayName = seller.businessName ?? seller.providerAccountId;
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "square",
    seller.providerAccountId,
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
      provider_subject_id: seller.providerAccountId,
      platform_mode: base.environment === "production" ? "live" : "sandbox",
      country: seller.country,
      currency: seller.currency,
    },
    "persisting_credential",
  );

  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "square",
    seller.providerAccountId,
    input.now,
  );
  const stored = await storeSquareDelegation(input, credentialRef, {
    merchantId: square.merchantId,
    providerAccountId: seller.providerAccountId,
  });
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

  const integration = await createConnectedIntegration(input.scope.database, {
    organisationId: base.organisationId,
    provider: "square",
    providerSubjectId: seller.providerAccountId,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: [...squareOnboardingAdapter.requiredScopes],
    createdByUserId: base.userId,
    providerAccountId: seller.providerAccountId,
    accountKind: "merchant_account",
    displayName: displayName,
    capabilities: [
      "payments.read",
      "payments.collect_in_person",
      "refunds.execute",
    ],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_accounts",
    {
      integration_account_ids: [integration.account.integrationAccountId],
    },
    "reconciling_webhooks",
  );
  // Terminal payment webhooks are registered with the certified terminal
  // binding, not at connection time.
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      account_scoped_webhook_created: false,
    },
    "discovering_resources",
  );

  const snapshotRevision = await persistProviderResourceSnapshot({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: integration.account.integrationAccountId,
    provider: "square",
    environment: base.environment,
    resources: [
      {
        canonicalResourceId: seller.providerAccountId,
        providerResourceId: seller.providerAccountId,
        providerAccountId: seller.providerAccountId,
        displayLabel: displayName,
        accessState: "accessible",
        providerRevision: `square-merchant:${seller.providerAccountId}`,
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
    },
    "finalizing",
  );

  const finalized = await finalizeConnectedIntegrationAccount({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: integration.account.integrationAccountId,
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
    integration.connection.providerConnectionId,
    requireConnectionCredentialAuthority(integration.connection)
      .credentialGeneration,
  );
  if (!cutover.ok) {
    return failProviderCompletion(input, attempt, current, cutover.error);
  }
  // The locations that take cards take Pantry's Square payments; a failed
  // link is tried again by the next provider check.
  await linkSquarePaymentLocations(square, base.organisationId);
  return finishProviderCompletion(
    input,
    attempt,
    current,
    integration.connection.providerConnectionId,
    [finalized.value.integrationAccountId],
    { kind: "healthy", evidenceCode: "provider_identity_verified" },
  );
}

/**
 * The provider check of a Square connection: Commerce still holds the
 * account's connection and can call Square with it, and the locations that
 * take cards take Pantry's Square payments.
 */
export async function observeSquareConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  if (input.credentialRef === null) {
    return squareObservationBlocked("provider_credential_unavailable");
  }
  const credential = await resolveProviderManifestCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider: "square",
    environment: input.environment,
    providerAccountId: input.providerAccountId,
    credentialRef: input.credentialRef,
  });
  if (!credential.ok) {
    return squareObservationBlocked("provider_credential_unavailable");
  }
  const square = await resolveCommerceMerchant(
    input.env,
    input.scope,
    input.organisationId,
  );
  if (square === null) {
    return squareObservationBlocked("provider_account_ineligible");
  }
  if (readSquareDelegation(credential.value) === null) {
    return squareObservationBlocked("provider_credential_unavailable");
  }
  const connection = await readCommerceSquareConnection(square);
  if (connection.kind === "missing") {
    return squareObservationBlocked("provider_credential_unavailable");
  }
  if (
    connection.kind === "unavailable" ||
    connection.connection.providerAccountId !== input.providerAccountId
  ) {
    return squareObservationBlocked("provider_identity_unverified");
  }
  await linkSquarePaymentLocations(square, input.organisationId);
  // Commerce calls Square with the connection's token, refreshed if due.
  const devices = await square.client.listSquareDevices(square.merchantId);
  return devices.ok
    ? { kind: "healthy", evidenceCode: "provider_identity_verified" }
    : squareObservationBlocked("provider_identity_unverified");
}

/** Stores the delegation record, which holds no Square token. */
async function storeSquareDelegation(
  input: Readonly<{
    env: CompleteProviderInput["env"];
    scope: CompleteProviderInput["scope"];
  }>,
  credentialRef: VaultHandle,
  delegation: SquareDelegation,
): Promise<Result<true, ProviderOnboardingError>> {
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.env,
    handle: credentialRef,
    secret: squareDelegationSecret(delegation),
    now: Date.now(),
  });
  return stored.ok
    ? { ok: true, value: true }
    : { ok: false, error: { code: "provider_credential_store_failed" } };
}

function squareObservationBlocked(
  reasonCode: string,
): ProviderManifestEvidence {
  return { kind: "blocked", reasonCode, repairActions: ["reconnect_provider"] };
}
