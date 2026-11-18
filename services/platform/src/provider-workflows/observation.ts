import {
  resolveProviderManifestCredential,
  resolveSlackHealthCheckCredential,
} from "../credential-vault";
import type { ProviderManifestEvidence } from "../data/provider-attempt";
import { newRequestId, parseWorkspaceId } from "../ids";
import { traceWarn } from "../observability";
import {
  observeSlackProviderIdentity,
  type SlackProviderIdentityObservation,
} from "../provider-adapters/slack";
import {
  stripeConnectWebhookConfiguration,
  stripeCredentialEnvironment,
  verifyStripeConnectWebhook,
} from "../provider-adapters/stripe";
import { isShopifyAdminDomain } from "../shopify/auth";
import { registerShopifyWebhooks } from "../shopify/connector/webhook-registration";
import type { ProviderObservationRequest } from "../provider-adapters/domain";
import { providerIngressOrigin } from "../provider-lifecycle/authorization";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import { linkStripePaymentAccount } from "../commerce/stripe-link";
import { resolveCommerceMerchant } from "../commerce/square-link";

export type { ProviderObservationRequest } from "../provider-adapters/domain";

export async function observeSlackConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const bearer = await resolveObservationBearer(input, "slack");
  if (bearer === null || input.env.SLACK_SIGNING_SECRET === undefined) {
    return blockedEvidence("provider_credential_unavailable", [
      "reconnect_provider",
    ]);
  }
  const observation = await observeSlackProviderIdentity({
    providerAccountId: input.providerAccountId,
    bearer,
    fetcher: input.fetcher,
  });
  if (observation.kind === "healthy") {
    return { kind: "healthy", evidenceCode: "provider_identity_verified" };
  }
  traceSlackFailure(input, observation);
  return blockedEvidence("provider_identity_unverified", [
    "reconnect_provider",
  ]);
}

export async function observeStripeConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const configuration = stripeConnectWebhookConfiguration(input.env);
  const clientSecret = input.env.STRIPE_CONNECT_CLIENT_SECRET;
  // The platform key decides the Stripe mode, as at connection.
  const stripeMode =
    clientSecret === undefined
      ? null
      : stripeCredentialEnvironment(clientSecret);
  if (!configuration.ok || clientSecret === undefined || stripeMode === null) {
    return blockedEvidence("provider_configuration_missing", [
      "configure_stripe_connect_webhook",
    ]);
  }
  const verified = await verifyStripeConnectWebhook({
    fetcher: input.fetcher,
    webhook: configuration.value,
    clientSecret,
    environment: stripeMode,
  });
  if (!verified.ok) {
    return blockedEvidence("provider_webhook_unhealthy", [
      "repair_provider_webhook",
    ]);
  }
  // Commerce takes the account's payments (Plan 80 step 5).
  const merchant = await resolveCommerceMerchant(
    input.env,
    input.scope,
    input.organisationId,
  );
  if (merchant !== null) {
    await linkStripePaymentAccount(
      merchant,
      input.organisationId,
      input.providerAccountId,
    );
  }
  return { kind: "healthy", evidenceCode: "provider_webhook_verified" };
}

export async function observeShopifyConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const bearer = await resolveObservationBearer(input, "shopify");
  if (bearer === null || !isShopifyAdminDomain(input.providerAccountId)) {
    return blockedEvidence("provider_credential_unavailable", [
      "reconnect_provider",
    ]);
  }
  const registration = await registerShopifyWebhooks({
    shopDomain: input.providerAccountId,
    accessToken: bearer,
    endpointUrl: `${providerIngressOrigin(input.env)}/hook/shopify/${input.organisationId}`,
    fetcher: input.fetcher,
  });
  if (!registration.ok) {
    return blockedEvidence("provider_webhook_unhealthy", [
      "repair_provider_webhook",
    ]);
  }
  return registration.value.ordersCreate.kind === "unavailable"
    ? {
        kind: "degraded",
        missingOptionalCapabilities: ["orders/create"],
        repairActions: ["repair_provider_webhook"],
      }
    : { kind: "healthy", evidenceCode: "provider_webhook_verified" };
}

export function observationUnsupported(): ProviderManifestEvidence {
  return { kind: "observation_unsupported" };
}

export function observeUnsupportedConnection(
  _input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  return Promise.resolve(observationUnsupported());
}

async function resolveObservationBearer(
  input: ProviderObservationRequest,
  provider: "slack" | "shopify",
): Promise<string | null> {
  if (input.credentialRef === null) {
    return null;
  }
  if (provider === "slack") {
    const installationIdentity = resolveConfiguredSlackInstallationIdentity({
      deploymentProfile: input.env.SATYR_DEPLOYMENT_PROFILE,
      appId: input.env.SLACK_APP_ID,
    });
    const workspaceId = parseWorkspaceId(input.providerAccountId);
    if (!installationIdentity.ok || !workspaceId.ok) {
      return null;
    }
    const credential = await resolveSlackHealthCheckCredential({
      env: input.env,
      keys: input.env,
      installationIdentity: installationIdentity.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      workspaceId: workspaceId.value,
    });
    return credential.ok && credential.value.kind === "bearer"
      ? credential.value.value
      : null;
  }
  const credential = await resolveProviderManifestCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider,
    environment: input.environment,
    providerAccountId: input.providerAccountId,
    credentialRef: input.credentialRef,
  });
  return credential.ok && credential.value.kind === "bearer"
    ? credential.value.value
    : null;
}

function traceSlackFailure(
  input: Pick<
    ProviderObservationRequest,
    "organisationId" | "integrationAccountId" | "providerAccountId"
  >,
  observation: Exclude<
    SlackProviderIdentityObservation,
    { readonly kind: "healthy" }
  >,
): void {
  const common = {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    integration_account_id: input.integrationAccountId,
    expected_workspace_id: input.providerAccountId,
    check_kind: observation.kind,
  };
  switch (observation.kind) {
    case "provider_rejected":
      traceWarn("provider_manifest.slack_identity_unverified", {
        ...common,
        http_status: observation.httpStatus,
        slack_error: observation.slackError,
      });
      return;
    case "workspace_mismatch":
      traceWarn("provider_manifest.slack_identity_unverified", {
        ...common,
        observed_workspace_id: observation.observedWorkspaceId,
      });
      return;
    case "invalid_response":
      traceWarn("provider_manifest.slack_identity_unverified", {
        ...common,
        http_status: observation.httpStatus,
      });
      return;
    case "transport_failure":
      traceWarn("provider_manifest.slack_identity_unverified", {
        ...common,
        error_name: observation.errorName,
      });
  }
}

function blockedEvidence(
  reasonCode: string,
  repairActions: readonly string[],
): ProviderManifestEvidence {
  return { kind: "blocked", reasonCode, repairActions };
}
