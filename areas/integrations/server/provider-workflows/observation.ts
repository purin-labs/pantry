import { resolveSlackHealthCheckCredential } from "@purin-labs/authority/credential-vault/index";
import type { ProviderManifestEvidence } from "@purin-labs/connections/data/provider-attempt";
import { newRequestId, parseWorkspaceId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import {
  observeSlackProviderIdentity,
  type SlackProviderIdentityObservation,
} from "../provider-adapters/slack";
import {
  stripeConnectWebhookConfiguration,
  stripeCredentialEnvironment,
  verifyStripeConnectWebhook,
} from "../provider-adapters/stripe";
import type { ProviderObservationRequest } from "@purin-labs/area-integrations-contract/server/provider-adapter";
import { blockedEvidence } from "../contract/observation-evidence";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import { linkStripePaymentAccount } from "@purin-labs/area-commerce-contract/server/stripe-link";
import { resolveCommerceMerchant } from "@purin-labs/area-commerce-contract/server/square-link";

export type { ProviderObservationRequest } from "@purin-labs/area-integrations-contract/server/provider-adapter";

export async function observeSlackConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const bearer = await resolveSlackObservationBearer(input);
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

function observationUnsupported(): ProviderManifestEvidence {
  return { kind: "observation_unsupported" };
}

export function observeUnsupportedConnection(
  _input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  return Promise.resolve(observationUnsupported());
}

async function resolveSlackObservationBearer(
  input: ProviderObservationRequest,
): Promise<string | null> {
  if (input.credentialRef === null) {
    return null;
  }
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: input.env.PANTRY_DEPLOYMENT_PROFILE,
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
