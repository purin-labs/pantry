import { storeOrganisationPlacementVaultSecret } from "@purin-labs/authority/credential-vault/service";
import { WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  attachIntegrationAccount,
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
} from "@purin-labs/connections/data/integration-account";
import type {
  ProvisioningProviderConnectionAttempt,
  ProviderManifestEvidence,
} from "@purin-labs/connections/data/provider-attempt";
import { persistProviderResourceSnapshot } from "@purin-labs/connections/data/provider-resource";
import { connectionParts } from "../contract/connection-parts";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import { whatsappOnboardingAdapter } from "../provider-adapters/whatsapp";
import { providerCallbackUri } from "../provider-lifecycle/authorization";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "@purin-labs/area-integrations-contract/server/provider-lifecycle";
import {
  advanceProviderPhase,
  completeProviderCredentialCutover,
  failProviderCompletion,
  failProviderCompletionWithEvidence,
  finishProviderCompletion,
  providerCredentialHandle,
  verifyExistingAccountIdentity,
} from "../contract/provisioning";
import { scopesAreComplete } from "@purin-labs/connections/provider-adapters/authorization";
import type { Result } from "@purin-labs/kernel/result";
import { resolveWhatsAppEmbeddedSignupCredential } from "@purin-labs/connections/whatsapp/application";
import {
  exchangeWhatsAppSignupCode,
  listWhatsAppPhoneNumbers,
  readWhatsAppSubscribedApps,
  subscribeWhatsAppApp,
  type WhatsAppGraphError,
  type WhatsAppSignupExchange,
} from "@purin-labs/connections/whatsapp/graph";
import type { WhatsAppBusinessAccountId } from "@purin-labs/connections/whatsapp/identifiers";

/**
 * A signup that comes back without a Business Portfolio or WhatsApp Business
 * Account is a different outcome from a malformed exchange: the operator may
 * have skipped the asset step, or Meta may not yet let businesses onboard
 * through Pantry's app. It gets its own reason so the portal can say so
 * instead of folding it into an ineligible account.
 */
export function whatsappExchangeFailure(
  error: WhatsAppGraphError,
): ProviderOnboardingError {
  switch (error.code) {
    case "whatsapp_signup_waba_missing":
    case "whatsapp_signup_portfolio_missing":
      return { code: "provider_asset_missing" };
    default:
      return { code: "provider_oauth_response_invalid" };
  }
}

/**
 * Embedded Signup completion. The browser returns an authorization code;
 * Pantry exchanges it once, validates the exact WABA and declared token lifetime,
 * stores the customer business token in the organisation Vault, and subscribes the
 * app for webhooks. Runtime calls resolve that connection credential only.
 *
 * Each discovered phone number becomes a candidate integration account in a
 * connected, processing-disabled state. Discovery claims nothing: the global
 * phone-number claim is taken when the owner selects a number, so a number
 * another organisation still answers for rejects only itself rather than stopping
 * the whole connection.
 */
export async function connectWhatsApp(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  const application = resolveWhatsAppEmbeddedSignupCredential(input.env);
  if (!application.ok) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  const exchanged = await exchangeWhatsAppSignupCode({
    appId: application.value.appId,
    appSecret: application.value.appSecret,
    code,
    redirectUri: providerCallbackUri(input.env, "whatsapp"),
    fetcher: input.fetcher,
  });
  if (!exchanged.ok) {
    return failProviderCompletionWithEvidence(
      input,
      attempt,
      current,
      whatsappExchangeFailure(exchanged.error),
      {
        redactedProviderStatus:
          exchanged.error.providerCode === null
            ? exchanged.error.code
            : `${exchanged.error.code}:${exchanged.error.providerCode}`,
        redactedProviderRequestId: null,
      },
    );
  }
  if (
    exchanged.value.credential.kind === "expiring_bearer" &&
    exchanged.value.credential.expiresAt <= input.now
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  const assets = exchanged.value.assets;
  if (!scopesAreComplete(whatsappOnboardingAdapter, assets.grantedScopes)) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "whatsapp",
    assets.wabaId,
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
      provider_subject_id: assets.wabaId,
      scope_count: assets.grantedScopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "whatsapp",
    assets.wabaId,
    input.now,
  );
  const stored = await storeOrganisationPlacementVaultSecret({
    scope: input.scope,
    keys: input.env,

    handle: credentialRef,
    secret: exchanged.value.credential,
    now: input.now,
  });
  if (!stored.ok) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_credential_store_failed",
    });
  }
  current = await advanceProviderPhase(
    input,
    current,
    "persisting_credential",
    whatsAppCredentialReceipt(exchanged.value.credential),
    "discovering_accounts",
  );
  const numbers = await listWhatsAppPhoneNumbers({
    wabaId: assets.wabaId,
    accessToken: exchanged.value.credential.value,
    fetcher: input.fetcher,
  });
  if (!numbers.ok || numbers.value.length === 0) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_account_ineligible",
    });
  }
  const [first, ...rest] = numbers.value;
  if (first === undefined) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_account_ineligible",
    });
  }
  const connected = await createConnectedIntegration(input.scope.database, {
    organisationId: base.organisationId,
    provider: "whatsapp",
    providerSubjectId: assets.wabaId,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: assets.grantedScopes,
    createdByUserId: base.userId,
    providerAccountId: first.phoneNumberId,
    accountKind: "phone_number",
    displayName: whatsappAccountLabel(first),
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  const accountIds: string[] = [connected.account.integrationAccountId];
  const registrations: {
    readonly integrationAccountId: IntegrationAccountId;
    readonly number: (typeof numbers.value)[number];
  }[] = [
    {
      integrationAccountId: connected.account.integrationAccountId,
      number: first,
    },
  ];
  for (const number of rest) {
    const attached = await attachIntegrationAccount(input.scope.database, {
      organisationId: base.organisationId,
      providerConnectionId: connected.connection.providerConnectionId,
      provider: "whatsapp",
      environment: base.environment,
      providerAccountId: number.phoneNumberId,
      accountKind: "phone_number",
      displayName: whatsappAccountLabel(number),
      capabilities: ["whatsapp.support.ingress"],
      audiencePolicy: { kind: "customer", consentRequired: true },
      retentionPolicy: { kind: "organisation_default" },
      now: input.now,
    });
    if (!attached.ok) {
      return failProviderCompletion(input, attempt, current, {
        code: "provider_account_ineligible",
      });
    }
    accountIds.push(attached.value.integrationAccountId);
    registrations.push({
      integrationAccountId: attached.value.integrationAccountId,
      number,
    });
  }
  for (const registration of registrations) {
    const registered = await connectionParts
      .use()
      .whatsapp.registerWhatsAppPhoneNumberAccount({
        db: input.scope.database,
        organisationId: base.organisationId,
        integrationAccountId: registration.integrationAccountId,
        providerConnectionId: connected.connection.providerConnectionId,
        environment: base.environment,
        businessPortfolioId: assets.businessPortfolioId,
        wabaId: assets.wabaId,
        phoneNumberId: registration.number.phoneNumberId,
        displayPhoneNumber: registration.number.displayPhoneNumber,
        verifiedName: registration.number.verifiedName,
        now: input.now,
      });
    if (!registered.ok) {
      return failProviderCompletion(input, attempt, current, {
        code: "provider_account_ineligible",
      });
    }
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_accounts",
    {
      integration_account_ids: accountIds,
    },
    "reconciling_webhooks",
  );
  const subscribed = await subscribeWhatsAppApp({
    wabaId: assets.wabaId,
    accessToken: exchanged.value.credential.value,
    fetcher: input.fetcher,
  });
  // Subscribing and being subscribed are different facts. Repeated
  // completions converge on the same subscription, so health is read back
  // from Meta rather than inferred from the call that asked for it.
  const verified = subscribed.ok
    ? await whatsappSubscriptionIsLive({
        wabaId: assets.wabaId,
        appId: application.value.appId,
        accessToken: exchanged.value.credential.value,
        fetcher: input.fetcher,
      })
    : false;
  const webhookHealth: ProviderManifestEvidence = verified
    ? { kind: "healthy", evidenceCode: "provider_webhook_verified" }
    : {
        kind: "blocked",
        reasonCode: subscribed.ok
          ? "whatsapp_subscription_unverified"
          : "whatsapp_subscription_failed",
        repairActions: ["reconnect_whatsapp"],
      };
  for (const registration of registrations) {
    await connectionParts.use().whatsapp.setWhatsAppProviderHealth({
      db: input.scope.database,
      organisationId: base.organisationId,
      integrationAccountId: registration.integrationAccountId,
      health: verified
        ? { kind: "healthy", webhookVerifiedAt: input.now }
        : subscribed.ok
          ? { kind: "degraded", reasonCode: "whatsapp_subscription_unverified" }
          : { kind: "unsubscribed" },
      now: input.now,
    });
  }
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      webhook_count: verified ? 1 : 0,
    },
    "discovering_resources",
  );
  const resourceSnapshotRevisions: string[] = [];
  const authority = requireConnectionCredentialAuthority(connected.connection);
  for (const registration of registrations) {
    resourceSnapshotRevisions.push(
      await persistProviderResourceSnapshot({
        db: input.scope.database,
        organisationId: base.organisationId,
        integrationAccountId: registration.integrationAccountId,
        provider: "whatsapp",
        environment: base.environment,
        resources: [
          {
            canonicalResourceId: WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
            providerResourceId: registration.number.phoneNumberId,
            providerAccountId: registration.number.phoneNumberId,
            displayLabel: "Active support Cases",
            accessState: "accessible",
            providerRevision: `credential:${authority.credentialGeneration}`,
            resourceKind: "active_support_cases",
          },
        ],
        now: input.now,
      }),
    );
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      discovered_phone_numbers: numbers.value.length,
      resource_snapshot_revisions: resourceSnapshotRevisions,
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
  const finalizedIds: IntegrationAccountId[] = [];
  for (const registration of registrations) {
    const finalized = await finalizeConnectedIntegrationAccount({
      db: input.scope.database,
      organisationId: base.organisationId,
      integrationAccountId: registration.integrationAccountId,
      now: input.now,
    });
    if (!finalized.ok) {
      return failProviderCompletion(input, attempt, current, {
        code: "provider_oauth_response_invalid",
      });
    }
    finalizedIds.push(finalized.value.integrationAccountId);
  }
  const cutover = await completeProviderCredentialCutover(
    input,
    base.organisationId,
    connected.connection.providerConnectionId,
    authority.credentialGeneration,
  );
  if (!cutover.ok) {
    return failProviderCompletion(input, attempt, current, cutover.error);
  }
  return finishProviderCompletion(
    input,
    attempt,
    current,
    connected.connection.providerConnectionId,
    finalizedIds,
    webhookHealth,
  );
}

function whatsAppCredentialReceipt(
  credential: WhatsAppSignupExchange["credential"],
): Readonly<Record<string, unknown>> {
  switch (credential.kind) {
    case "bearer":
      return {
        credential_stored: true,
        credential_lifetime: "provider_managed",
      };
    case "expiring_bearer":
      return {
        credential_stored: true,
        credential_lifetime: "expires",
        credential_expires_at: credential.expiresAt,
      };
  }
}

/**
 * Confirms Pantry's own application is in the WABA's subscribed list. An
 * unreadable list is treated as unverified, never as healthy.
 */
export async function whatsappSubscriptionIsLive(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    appId: string;
    accessToken: string;
    fetcher: typeof fetch;
  }>,
): Promise<boolean> {
  const subscribed = await readWhatsAppSubscribedApps({
    wabaId: input.wabaId,
    accessToken: input.accessToken,
    fetcher: input.fetcher,
  });
  return subscribed.ok && subscribed.value.includes(input.appId);
}

function whatsappAccountLabel(
  number: Readonly<{ displayPhoneNumber: string; verifiedName: string }>,
): string {
  return number.verifiedName.length === 0
    ? number.displayPhoneNumber
    : `${number.verifiedName} (${number.displayPhoneNumber})`;
}
