import { runtimeFetch } from "../runtime-fetch";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  readChannelIdPath,
  readIntegrationAccountIdField,
  readStringField,
  readOrganisationIdField,
  readWorkspaceIdField,
} from "../boundary";
import {
  compileAndStoreCueSnapshot,
  writeTierOneStripeSubscription,
} from "../cues/engine";
import {
  requireConnectionCredentialAuthority,
  resolveActiveProviderAccountContext,
  upsertProviderWebhook,
} from "../data/integration-account";
import type { Env } from "../env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "../http";
import {
  newRequestId,
  parseThreadKey,
} from "../ids";
import { traceLog } from "../observability";
import {
  registerStripeWebhook,
  resolveStripeWebhookSecrets,
} from "./connector";
import { resolveStripeWriteCredential } from "./action-execution";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "../credential-vault";
import { fieldErrorResponse, isAuthorizedOrganisationAdminRequest, jsonBodyErrorResponse, parsePublicServiceUrl } from "../gateway/request-helpers";

export async function handleConfigureStripeConnector(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;

  const integrationAccountId = readIntegrationAccountIdField(body.value);
  if (!integrationAccountId.ok) {
    return fieldErrorResponse(integrationAccountId.error);
  }

  const publicOrigin = parsePublicServiceUrl(env.PANTRY_PUBLIC_ORIGIN);

  if (publicOrigin === null) {
    return errorResponse(
      "public_origin_invalid",
      "Public Worker origin is invalid.",
      500,
    );
  }

  const credential = await resolveStripeWriteCredential({
    env,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });

  if (!credential.ok) {
    return errorResponse(
      credential.error.code,
      "Stripe test credential is unavailable.",
      503,
    );
  }

  if (
    credential.value.kind !== "bearer" ||
    !credential.value.value.startsWith("sk_test_")
  ) {
    return errorResponse(
      "stripe_live_credential_denied",
      "Stripe test key required.",
      403,
    );
  }

  const accountContext = await resolveActiveProviderAccountContext({
    db: scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });

  if (!accountContext.ok) {
    return errorResponse(
      accountContext.error.code,
      "Stripe account is unavailable.",
      409,
    );
  }

  if (accountContext.value.account.provider !== "stripe") {
    return errorResponse(
      "stripe_integration_account_invalid",
      "Stripe account is invalid.",
      422,
    );
  }

  const endpointUrl = `${publicOrigin}/hook/stripe/${encodeURIComponent(organisationId.value)}`;
  const handle = parseVaultHandle(
    `vault:stripe:webhook:${organisationId.value.toLowerCase().replaceAll("_", "-")}`,
  );

  if (!handle.ok) {
    return errorResponse(
      "invalid_vault_handle",
      "Stripe webhook handle is invalid.",
      500,
    );
  }

  const existingSecrets = await resolveStripeWebhookSecrets(env, scope);
  const existingSigningSecret =
    existingSecrets.ok && existingSecrets.value.length > 0;
  const registration = await registerStripeWebhook({
    stripeTestKey: credential.value.value,
    endpointUrl,
    idempotencyKey: `satyr-stripe-connector:${organisationId.value}`,
    existingSigningSecret,
    fetcher: runtimeFetch,
  });

  if (!registration.ok) {
    return errorResponse(
      registration.error.code,
      "Stripe webhook registration failed.",
      registration.error.code === "stripe_registration_failed"
        ? registration.error.status
        : 502,
    );
  }

  const now = Date.now();
  if (registration.value.kind === "created") {
    const stored = await storeVaultSecret({
      db: scope.database,
      keys: env,
      organisationId: organisationId.value,
      handle: handle.value,
      secret: {
        kind: "header",
        header: "stripe-signing-secret",
        value: registration.value.signingSecret,
      },
      now,
    });

    if (!stored.ok) {
      return errorResponse(
        stored.error.code,
        "Stripe webhook secret was not stored.",
        500,
      );
    }
  }

  await upsertProviderWebhook({
    db: scope.database,
    organisationId: organisationId.value,
    integrationAccountId: accountContext.value.account.integrationAccountId,
    provider: "stripe",
    environment: accountContext.value.account.environment,
    providerNativeId: registration.value.endpointId,
    eventType: "commerce_events",
    signingSecretRef: handle.value,
    credentialGeneration: requireConnectionCredentialAuthority(
      accountContext.value.connection,
    ).credentialGeneration,
    lifecycle: { kind: "live", lastVerifiedAt: now },
    now,
  });

  traceLog("stripe.connector_configured", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    endpoint_id: registration.value.endpointId,
    endpoint_url: endpointUrl,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    integrationAccountId: accountContext.value.account.integrationAccountId,
    provider: "stripe",
    endpointId: registration.value.endpointId,
    endpointUrl,
    webhookStatus: "live",
  });
}

export async function handleConfigureStripeFailureCues(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const workspaceId = readWorkspaceIdField(body.value);
  const channelIdRaw = readStringField(body.value, "channelId");

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  if (!workspaceId.ok) {
    return fieldErrorResponse(workspaceId.error);
  }

  if (!channelIdRaw.ok) {
    return fieldErrorResponse(channelIdRaw.error);
  }

  const channelId = readChannelIdPath(channelIdRaw.value);
  const threadKey = parseThreadKey(
    `slack:${workspaceId.value}:${channelIdRaw.value}:channel`,
  );

  if (!channelId.ok) {
    return fieldErrorResponse(channelId.error);
  }

  if (!threadKey.ok) {
    return errorResponse("invalid_field", "Cue thread is invalid.", 422);
  }

  await writeTierOneStripeSubscription({
    db: scope.database,
    organisationId: organisationId.value,
    subscriptionId: "stripe-charge-failed-main",
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    threadKey: threadKey.value,
    eventType: "charge.failed",
    template:
      "A Stripe test charge failed. Review the payment and propose the next safe action.",
    delivery: { kind: "immediate" },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  await writeTierOneStripeSubscription({
    db: scope.database,
    organisationId: organisationId.value,
    subscriptionId: "stripe-invoice-payment-failed-main",
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    threadKey: threadKey.value,
    eventType: "invoice.payment_failed",
    template:
      "A Stripe invoice payment failed. Review collection status and propose the next safe action.",
    delivery: { kind: "immediate" },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  await writeTierOneStripeSubscription({
    db: scope.database,
    organisationId: organisationId.value,
    subscriptionId: "stripe-refund-failed-main",
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    threadKey: threadKey.value,
    eventType: "refund.failed",
    template:
      "A Stripe refund failed. Review the refund and propose the next safe action.",
    delivery: { kind: "immediate" },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  await writeTierOneStripeSubscription({
    db: scope.database,
    organisationId: organisationId.value,
    subscriptionId: "stripe-subscription-deleted-main",
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    threadKey: threadKey.value,
    eventType: "customer.subscription.deleted",
    template:
      "A Stripe subscription ended. Review the customer state and determine whether follow-up is needed.",
    delivery: { kind: "digest", windowMs: 60 * 60 * 1000 },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  const snapshot = await compileAndStoreCueSnapshot({
    db: scope.database,
    kv: env.POLICY_KV,
    organisationId: organisationId.value,
    now: Date.now(),
  });

  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    subscriptionIds: [
      "stripe-charge-failed-main",
      "stripe-invoice-payment-failed-main",
      "stripe-refund-failed-main",
      "stripe-subscription-deleted-main",
    ],
    snapshotVersion: snapshot.version,
  });
}
