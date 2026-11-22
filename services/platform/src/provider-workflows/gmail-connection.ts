import {
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "../authorization/capability-catalogue";
import { connectionParts } from "../integrations/contract/connection-parts";
import {
  createConnectedIntegration,
  requireConnectionCredentialAuthority,
} from "@purin-labs/connections/data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "@purin-labs/connections/data/provider-attempt";
import { persistProviderResourceSnapshot } from "@purin-labs/connections/data/provider-resource";
import { exchangeGmailOAuthCode } from "../mail/gmail-oauth";
import { gmailRequiredScopesForProduct } from "../provider-adapters/gmail";
import {
  gmailProductFromScopes,
  type GmailAuthorizationProduct,
} from "@purin-labs/connections/mail/gmail-authorization";
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
  finalizeProviderConnection,
} from "../integrations/contract/provisioning";
import type { Result } from "@purin-labs/kernel/result";

export async function connectGmail(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  if (attempt.context.provider !== "gmail") {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_context_invalid",
    });
  }
  const product = attempt.context.authorizationProduct;
  const exchanged = await exchangeGmailOAuthCode({
    env: input.env,
    code,
    product,
    redirectUri: providerCallbackUri(input.env, "gmail"),
    pkceVerifier: attempt.state.pkceVerifier,
    now: input.now,
    fetcher: input.fetcher,
  });
  if (!exchanged.ok) {
    return failProviderCompletion(input, attempt, current, exchanged.error);
  }
  if (!scopesAreComplete(product, exchanged.value.grantedScopes)) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "gmail",
    exchanged.value.googleSubject,
  );
  if (!accountIdentity.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      accountIdentity.error,
    );
  }
  const senderClaimant = await connectionParts
    .use()
    .mailbox.readEmailSenderIdentityClaimant({
      db: input.scope.database,
      environment: base.environment,
      googleSubject: exchanged.value.googleSubject,
    });
  if (
    senderClaimant !== null &&
    senderClaimant.organisationId !== base.organisationId
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_mailbox_identity_claimed",
    });
  }
  const mailboxClaimant = await connectionParts
    .use()
    .mailbox.readEmailMailboxIdentityClaimant({
      db: input.scope.database,
      environment: base.environment,
      googleSubject: exchanged.value.googleSubject,
    });
  if (
    mailboxClaimant !== null &&
    mailboxClaimant.organisationId !== base.organisationId
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_mailbox_identity_claimed",
    });
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_identity",
    {
      provider_subject_id: exchanged.value.googleSubject,
      scope_count: exchanged.value.grantedScopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "gmail",
    exchanged.value.googleSubject,
    input.now,
  );
  const stored = await storeOAuthCredential(
    input.env,
    input.scope,
    credentialRef,
    exchanged.value.tokens,
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
    provider: "gmail",
    providerSubjectId: exchanged.value.googleSubject,
    environment: base.environment,
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: exchanged.value.grantedScopes,
    createdByUserId: base.userId,
    providerAccountId: exchanged.value.googleSubject,
    accountKind: "mailbox",
    displayName: exchanged.value.email,
    authorizationProduct: product,
    capabilities:
      product === "full_mailbox_pilot"
        ? ["mailbox.ingress", "email.operational.propose"]
        : ["email.operational.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  const senderRegistered = await connectionParts
    .use()
    .mailbox.registerEmailSenderAccount({
      db: input.scope.database,
      integrationAccountId: connected.account.integrationAccountId,
      organisationId: base.organisationId,
      environment: base.environment,
      googleSubject: exchanged.value.googleSubject,
      observedAddress: exchanged.value.email,
      now: input.now,
    });
  if (!senderRegistered.ok) {
    return failProviderCompletion(input, attempt, current, {
      code:
        senderRegistered.error.code === "email_sender_identity_claimed"
          ? "provider_mailbox_identity_claimed"
          : "provider_oauth_response_invalid",
    });
  }
  if (product === "full_mailbox_pilot") {
    const registered = await connectionParts
      .use()
      .mailbox.registerEmailMailboxAccount({
        db: input.scope.database,
        organisationId: base.organisationId,
        integrationAccountId: connected.account.integrationAccountId,
        environment: base.environment,
        googleSubject: exchanged.value.googleSubject,
        observedAddress: exchanged.value.email,
        now: input.now,
      });
    if (!registered.ok) {
      return failProviderCompletion(input, attempt, current, {
        code: "provider_mailbox_identity_claimed",
      });
    }
  }
  current = await advanceProviderPhase(
    input,
    current,
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
  const authority = requireConnectionCredentialAuthority(connected.connection);
  const resourceSnapshotRevision = await persistProviderResourceSnapshot({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: "gmail",
    environment: base.environment,
    resources: [
      ...(product === "full_mailbox_pilot"
        ? [
            {
              canonicalResourceId: EMAIL_MAILBOX_RESOURCE_SCOPE,
              providerResourceId: exchanged.value.googleSubject,
              providerAccountId: exchanged.value.googleSubject,
              displayLabel: exchanged.value.email,
              accessState: "accessible" as const,
              providerRevision: `credential:${authority.credentialGeneration}`,
              resourceKind: "gmail_mailbox",
            },
          ]
        : []),
      {
        canonicalResourceId: EMAIL_OPERATIONAL_RESOURCE_SCOPE,
        providerResourceId: exchanged.value.googleSubject,
        providerAccountId: exchanged.value.googleSubject,
        displayLabel: exchanged.value.email,
        accessState: "accessible" as const,
        providerRevision: `credential:${authority.credentialGeneration}`,
        resourceKind: "gmail_sender",
      },
    ],
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      resource_snapshot_revision: resourceSnapshotRevision,
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
  return finalizeProviderConnection(input, attempt, current, connected, {
    kind: "healthy",
    evidenceCode: "callback_identity_verified",
  });
}

function scopesAreComplete(
  product: GmailAuthorizationProduct,
  grantedScopes: readonly string[],
): boolean {
  return (
    gmailProductFromScopes(grantedScopes) === product &&
    gmailRequiredScopesForProduct(product).length > 0
  );
}
