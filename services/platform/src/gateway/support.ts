import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { prepareSlackInstallationLifecycleEvent } from "../data/slack-installation-records";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Track } from "@purin-labs/contracts";
import type {
  CanonicalCommerceDelivery,
  CommerceSource,
} from "@purin-labs/commerce-contracts";
import {
  createCueQueueMessage,
  type NormalizedCueEvent,
} from "../cues/engine";
import type { OrganisationInstallRecord } from "../data/organisation";
import {
  resolvePinnedAgentProfile,
  type PinnedAgentProfile,
} from "../data/pinned-agent-profile";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import type {
  ActorIdentity,
  ActorRegistryEntry,
} from "../actors/actor-registry";
import type { Env } from "@purin-labs/kernel/env";
import {
  requireActiveOrganisationActor,
  requireActiveOrganisationActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
  type ActorResolutionError,
} from "../actors/actor-router";
import {
  errorResponse,
  jsonResponse,
} from "@purin-labs/kernel/http";
import {
  createCommerceDeliveryQueueMessage,
  type CommerceDeliveryQueueMessage,
  type CommerceOutboxReconcileQueueMessage,
} from "../commerce/contract/queue-messages";
import type { EmailChangeQueueMessage } from "../mail/queue-messages";
import type { IngressQueueMessageError } from "@purin-labs/kernel/queue-fields";
import type { ShopifyCommerceRefreshQueueMessage } from "../shopify/queue-messages";
import { gmailConnectorIdValue } from "../mail-inbox/contract/connector-ids";
import {
  parseConnectorId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import {
  traceLog,
  traceWarn,
} from "@purin-labs/kernel/observability";
import { fetchShopifyOrderCommerceRefresh } from "../shopify/connector/initial-sync";
import { resolveShopifyWriteCredential } from "../shopify/action-execution";
import type { Result } from "@purin-labs/kernel/result";
import type {
  SlackEnvelope,
  SlackPayloadError,
} from "../slack/events";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import {
  disconnectSlackInstallation,
  resolveSlackInstallation,
} from "../slack/installation-store";
import {
  normalizeShopifyCommerceOrderDelivery,
  normalizeShopifyCommerceResourceDelivery,
} from "../shopify/delivery-normalizers";
import {
  parseCanonicalCommerceDelivery,
  parseCommerceCueFacts,
} from "../actors/commerce-projection";
import { commerceObservationIdentity } from "../commerce/contract/observation-identity";
import {
  failCommerceLabRun,
  listCommerceLabRuns,
} from "../commerce-lab/lab-metadata";
import { reconcileCommerceOutbox } from "../commerce/outbox-worker";
import type {
  Variant,
  VariantBy,
} from "@purin-labs/type-utils";
import {
  assertNever,
  parseJsonOrNull,
} from "@purin-labs/std";

export type QuarantinedCaseActorRegistryEntry = VariantBy<
  ActorRegistryEntry,
  "lifecycleStatus",
  "quarantined"
> & {
  readonly identity: VariantBy<ActorIdentity, "objectKind", "case">;
};

export type HealthBody = {
  ok: true;
  service: "integration-gateway";
  tracks: readonly Track[];
};

export const EVENT_QUEUE_RETRY_DELAY_SECONDS = 30;

/**
 * The published instructions and skills one resolved automation runs. A
 * resolution that no longer reads back — an installation archived between
 * resolution and dispatch, or a skill revision that has gone — runs the
 * platform harness rules alone rather than a partial instruction set.
 */
export async function pinnedAgentForAutomation(
  scope: OrganisationExecutionScope,
  requestId: RequestId,
  automation: Readonly<{
    readonly binding: Readonly<{ readonly installationId: string }>;
    readonly skillRefs: readonly {
      readonly skillId: string;
      readonly revision: number;
    }[];
  }> | null,
): Promise<PinnedAgentProfile | null> {
  if (automation === null) {
    return null;
  }
  const profile = await resolvePinnedAgentProfile(
    scope.database,
    scope.organisationId,
    automation.binding.installationId,
    automation.skillRefs,
    // A new automation run adopts whatever the installation currently points
    // at; the pin it records afterwards is what later turns hold to.
    null,
  );
  if (profile.ok) {
    return profile.value;
  }
  traceWarn("agent_profile.unavailable", {
    requestId,
    organisationId: scope.organisationId,
    installationId: automation.binding.installationId,
    reason: profile.error.code,
  });
  return null;
}

export async function handleSlackInstallationRevoked(
  env: Env,
  event: Variant<SlackEnvelope, "installation_revoked">["event"],
  requestId: RequestId,
  receivedAt: number,
): Promise<Response> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (
    !installationIdentity.ok ||
    installationIdentity.value.appId !== event.appId
  ) {
    return errorResponse(
      "slack_installation_identity_mismatch",
      "Slack app identity does not match this deployment.",
      401,
    );
  }
  const installation = await resolveSlackInstallation(env.DB, {
    ...installationIdentity.value,
    workspaceId: event.workspaceId,
  });
  if (installation.kind !== "existing") {
    return installation.kind === "available"
      ? jsonResponse({ ok: true, requestId, ignored: "installation_missing" })
      : errorResponse(
          "slack_installation_corrupt",
          "Slack installation state is unavailable.",
          503,
        );
  }
  if (installation.lifecycle !== "revoked") {
    const disconnected = await disconnectSlackInstallation({
      env,
      installationId: installation.installationId,
      disconnectedAt: event.occurredAt,
    });
    if (!disconnected.ok) {
      return errorResponse(
        disconnected.error.code,
        "Slack installation revocation could not be recorded.",
        503,
      );
    }
  }
  await prepareSlackInstallationLifecycleEvent(env.DB, {
    eventId: event.eventId,
    installationId: installation.installationId,
    reason: event.reason,
    occurredAt: event.occurredAt,
    recordedAt: receivedAt,
  }).run();
  traceLog("integration_gateway.slack.installation_revoked", {
    requestId,
    workspace_id: event.workspaceId,
    event_id: event.eventId,
    reason: event.reason,
  });
  return jsonResponse({ ok: true, requestId, revoked: event.reason });
}

export async function ensureOrganisationObject(
  env: Env,
  install: OrganisationInstallRecord,
): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: install.organisationId,
    now: install.installedAt,
  });

  await organisation.ensureOrganisation({
    organisationId: install.organisationId,
    name: install.name,
    plan: install.plan,
    status: install.organisationStatus,
    createdAt: install.installedAt,
  });
}

/**
 * Composes an operator-configured trigger instruction body onto the derived
 * event facts (plan 30). The typed facts always lead; a NULL body preserves
 * the derived objective exactly.
 */
export function composeTriggerInstruction(
  derived: string,
  instructionBody: string | null,
): string {
  return instructionBody === null
    ? derived
    : `${derived}\n\n${instructionBody}`;
}

export function inventoryCasePurpose(
  event: Extract<
    NormalizedCueEvent,
    {
      source: "commerce";
      eventType: "inventory_shortage" | "inventory_low_stock";
    }
  >,
): string {
  return event.eventType === "inventory_low_stock"
    ? `Review low stock for ${event.payload.itemName} at ${event.payload.locationId}.`
    : `Resolve inventory shortage for ${event.payload.sku} at ${event.payload.locationId}.`;
}

export async function handleCommerceOutboxReconcileQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: CommerceOutboxReconcileQueueMessage,
): Promise<void> {
  const result = await reconcileCommerceOutbox({ env, message: body });
  switch (result.kind) {
    case "drained":
      traceLog("event_queue.commerce_deliveries_drained", {
        requestId: body.requestId,
        message_id: message.id,
        acknowledged: result.acknowledged,
        replayed: result.replayed,
        rejected: result.rejected,
      });
      message.ack();
      return;
    case "rejected":
      traceWarn("event_queue.commerce_delivery_rejected", {
        requestId: body.requestId,
        message_id: message.id,
        delivery_id: result.deliveryId ?? "",
        error_code: result.code,
      });
      message.ack();
      return;
    case "retry":
      traceWarn("event_queue.commerce_delivery_retry", {
        requestId: body.requestId,
        message_id: message.id,
        delivery_id: result.deliveryId ?? "",
        error_code: result.code,
      });
      message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
      return;
    default:
      return assertNever(result);
  }
}

export async function handleShopifyCommerceRefreshQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: ShopifyCommerceRefreshQueueMessage,
): Promise<void> {
  const credential = await resolveShopifyWriteCredential({
    env,
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    fetcher: runtimeFetch,
    now: Date.now(),
  });
  if (!credential.ok || credential.value.shopDomain !== body.shopDomain) {
    traceWarn("event_queue.shopify_refresh_credential_unavailable", {
      requestId: body.requestId,
      message_id: message.id,
      webhook_id: body.webhookId,
    });
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }

  const snapshot = await fetchShopifyOrderCommerceRefresh({
    shopDomain: credential.value.shopDomain,
    accessToken: credential.value.accessToken,
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    observedAt: body.receivedAt,
    orderGid: body.target.orderGid,
    webhookId: body.webhookId,
    fetcher: runtimeFetch,
  });
  if (!snapshot.ok) {
    traceWarn("event_queue.shopify_refresh_failed", {
      requestId: body.requestId,
      message_id: message.id,
      webhook_id: body.webhookId,
      reason: snapshot.error.code,
    });
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }

  const deliveries: CanonicalCommerceDelivery[] = [];
  const order = normalizeShopifyCommerceOrderDelivery(snapshot.value.order);
  if (!order.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  deliveries.push(order.value);
  for (const resource of snapshot.value.resources) {
    const normalized = normalizeShopifyCommerceResourceDelivery(resource);
    if (!normalized.ok) {
      message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }
    deliveries.push(normalized.value);
  }
  for (const delivery of deliveries) {
    await env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: body.requestId,
        receivedAt: body.receivedAt,
        organisationId: body.organisationId,
        integrationAccountId: body.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(delivery),
        canonicalCueFactsJson: "[]",
      }),
      { contentType: "json" },
    );
  }
  traceLog("event_queue.shopify_refresh_queued", {
    requestId: body.requestId,
    message_id: message.id,
    webhook_id: body.webhookId,
    delivery_count: deliveries.length,
  });
  message.ack();
}

export async function handleCommerceDeliveryQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: CommerceDeliveryQueueMessage,
): Promise<void> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    body.organisationId,
  );
  if (!execution.ok) {
    retryCommerceQueueMessage(message, body, execution.error.code);
    return;
  }
  const scope = execution.value;
  const labRun = await resolveCommerceLabQueueRun(scope.database, body);

  switch (labRun.kind) {
    case "active":
      break;
    case "stale":
      traceLog("event_queue.commerce_lab_stale", {
        requestId: body.requestId,
        message_id: message.id,
        lab_run_id: body.labRunId ?? "",
      });
      message.ack();
      return;
    case "retry":
      retryCommerceQueueMessage(message, body, labRun.code);
      return;
    default:
      assertNever(labRun);
  }

  const rawDelivery = parseJsonOrNull(body.canonicalDeliveryJson);
  const delivery = parseCanonicalCommerceDelivery(rawDelivery);

  if (!delivery.ok) {
    await rejectCommerceQueueMessage({
      message,
      scope,
      body,
      failureCode: delivery.error.code,
      failureProviderEventId: rawProviderDeliveryId(rawDelivery),
      failureProjectionId: null,
    });
    return;
  }

  const cueFacts = parseCommerceCueFacts(
    parseJsonOrNull(body.canonicalCueFactsJson),
  );

  if (!cueFacts.ok) {
    await rejectCommerceQueueMessage({
      message,
      scope,
      body,
      failureCode: cueFacts.error.code,
      failureProviderEventId: delivery.value.providerDeliveryId,
      failureProjectionId: commerceDeliveryEvidenceId(delivery.value),
    });
    return;
  }

  const deliveryAuthority = commerceDeliveryAuthority(delivery.value);
  if (!deliveryAuthority.ok) {
    await rejectCommerceQueueMessage({
      message,
      scope,
      body,
      failureCode: deliveryAuthority.error.code,
      failureProviderEventId: delivery.value.providerDeliveryId,
      failureProjectionId: commerceDeliveryEvidenceId(delivery.value),
    });
    return;
  }
  let commerceSystem: import("../actors/commerce-projection").CommerceSystemStorageAuthority =
    {
      kind: "lab",
      revision: null,
    };
  if (deliveryAuthority.value.provider !== "lab") {
    const selected = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: body.organisationId,
    });
    if (
      !selected.ok ||
      selected.value.provider !== deliveryAuthority.value.provider ||
      selected.value.integrationAccountId !== body.integrationAccountId
    ) {
      await rejectCommerceQueueMessage({
        message,
        scope,
        body,
        failureCode: "commerce_system_authority_mismatch",
        failureProviderEventId: delivery.value.providerDeliveryId,
        failureProjectionId: commerceDeliveryEvidenceId(delivery.value),
      });
      return;
    }
    commerceSystem = {
      kind: selected.value.commerceSystem.kind,
      revision: selected.value.commerceSystem.revision,
    };
  }

  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: body.organisationId,
    placement: scope.placement,
    now: body.receivedAt,
  });
  const applied = await organisation.applyCommerceDelivery({
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    delivery: delivery.value,
    cueFacts: cueFacts.value,
    labRunId: body.labRunId,
    processedAt: body.receivedAt,
    commerceSystem,
  });

  if (!applied.ok) {
    retryCommerceQueueMessage(message, body, applied.error.code);
    return;
  }

  for (const cue of applied.value.pendingCues) {
    if (cue.state !== "pending") {
      continue;
    }
    const enqueuedAt = Date.now();
    await env.CUE_Q.send(
      createCueQueueMessage({
        requestId: body.requestId,
        receivedAt: body.receivedAt,
        event: cue.event,
      }),
    );
    const marked = await organisation.markCommerceCuesEnqueued({
      organisationId: body.organisationId,
      nativeIds: [cue.nativeId],
      enqueuedAt,
    });
    if (!marked.ok) {
      retryCommerceQueueMessage(message, body, marked.error.code);
      return;
    }
  }

  traceLog("event_queue.commerce_applied", {
    requestId: body.requestId,
    message_id: message.id,
    attempts: message.attempts,
    provider_delivery_id: delivery.value.providerDeliveryId,
    disposition: applied.value.disposition,
    observation_count: applied.value.observations.length,
  });
  message.ack();
}

type CommerceLabQueueRunResolution =
  | { readonly kind: "active" }
  | { readonly kind: "stale" }
  | { readonly kind: "retry"; readonly code: string };

async function resolveCommerceLabQueueRun(
  db: OrganisationDatabase,
  body: CommerceDeliveryQueueMessage,
): Promise<CommerceLabQueueRunResolution> {
  if (body.labRunId === null) {
    return { kind: "active" };
  }
  const runs = await listCommerceLabRuns({
    db,
    organisationId: body.organisationId,
    limit: 50,
  });
  if (!runs.ok) {
    return { kind: "retry", code: runs.error.code };
  }
  for (const run of runs.value) {
    if (run.runId === body.labRunId) {
      return run.result === "running" ? { kind: "active" } : { kind: "stale" };
    }
  }
  return { kind: "stale" };
}

function retryCommerceQueueMessage(
  message: Message<unknown>,
  body: CommerceDeliveryQueueMessage,
  errorCode: string,
): void {
  traceWarn("event_queue.commerce_retry", {
    requestId: body.requestId,
    message_id: message.id,
    attempts: message.attempts,
    error_code: errorCode,
  });
  message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
}

async function rejectCommerceQueueMessage(input: {
  readonly message: Message<unknown>;
  readonly scope: OrganisationExecutionScope;
  readonly body: CommerceDeliveryQueueMessage;
  readonly failureCode: string;
  readonly failureProviderEventId: string | null;
  readonly failureProjectionId: string | null;
}): Promise<void> {
  if (input.body.labRunId !== null) {
    await failCommerceLabRun({
      db: input.scope.database,
      organisationId: input.body.organisationId,
      runId: input.body.labRunId,
      completedAt: Date.now(),
      failureStage: "queue_to_projection",
      failureCode: input.failureCode,
      failureProviderEventId: input.failureProviderEventId,
      failureProjectionId: input.failureProjectionId,
      failureSlackEffectId: null,
    });
  }

  traceWarn("event_queue.commerce_rejected", {
    requestId: input.body.requestId,
    message_id: input.message.id,
    attempts: input.message.attempts,
    error_code: input.failureCode,
  });
  input.message.ack();
}

function rawProviderDeliveryId(raw: unknown): string | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Object.hasOwn(raw, "providerDeliveryId")
  ) {
    return null;
  }
  const providerDeliveryId = Reflect.get(raw, "providerDeliveryId");
  return typeof providerDeliveryId === "string" && providerDeliveryId.length > 0
    ? providerDeliveryId
    : null;
}

function commerceDeliveryEvidenceId(
  delivery: CanonicalCommerceDelivery,
): string | null {
  const observation = delivery.observations[0];
  if (observation === undefined) {
    return null;
  }
  const identity = commerceObservationIdentity(observation);
  return [identity.kind, identity.canonicalId, identity.revision].join(":");
}

function commerceDeliveryAuthority(delivery: CanonicalCommerceDelivery): Result<
  Readonly<{
    provider: "shopify" | "commerce" | "lab";
    integrationAccountId: string;
  }>,
  Readonly<{
    code:
      | "commerce_delivery_provider_mixed"
      | "commerce_delivery_provider_unsupported";
  }>
> {
  const first = delivery.observations[0];
  if (first === undefined) {
    return {
      ok: false,
      error: { code: "commerce_delivery_provider_unsupported" },
    };
  }
  const identity = commerceObservationProviderIdentity(first);
  if (identity.provider === "stripe") {
    return {
      ok: false,
      error: { code: "commerce_delivery_provider_unsupported" },
    };
  }
  for (const observation of delivery.observations.slice(1)) {
    const candidate = commerceObservationProviderIdentity(observation);
    if (
      candidate.provider !== identity.provider ||
      candidate.integrationAccountId !== identity.integrationAccountId
    ) {
      return { ok: false, error: { code: "commerce_delivery_provider_mixed" } };
    }
  }
  return {
    ok: true,
    value: {
      provider: identity.provider,
      integrationAccountId: identity.integrationAccountId,
    },
  };
}

function commerceObservationProviderIdentity(
  observation: CanonicalCommerceDelivery["observations"][number],
): Readonly<{
  provider: CommerceSource;
  integrationAccountId: string;
}> {
  const provenance =
    observation.kind === "delete"
      ? observation.provenance
      : observation.projection.projection.provenance;
  return {
    provider: provenance.source,
    integrationAccountId: provenance.integrationAccountId,
  };
}

export function queueErrorField(error: IngressQueueMessageError): string {
  if (error.code === "missing_field" || error.code === "invalid_field") {
    return error.field;
  }

  return "";
}

export function identityLinkBrowserUrl(env: Env, token: string): string {
  return `${env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "")}/identity/link?token=${token}`;
}

export function actorResolutionErrorResponse(error: ActorResolutionError): Response {
  switch (error.code) {
    case "invalid_organisation_placement":
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
      return errorResponse(
        error.code,
        "Regional placement is unavailable.",
        503,
      );
    case "organisation_placement_missing":
    case "registry_entry_missing":
      return errorResponse(
        error.code,
        "Actor activation state was not found.",
        404,
      );
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "registry_entry_not_active":
    case "registry_schema_mismatch":
    case "actor_activation_conflict":
      return errorResponse(
        error.code,
        "Actor activation conflicts with current state.",
        409,
      );
    case "invalid_quarantine_reason":
      return errorResponse(
        error.code,
        "Actor activation state is invalid.",
        422,
      );
    case "organisation_placement_corrupt":
    case "registry_entry_corrupt":
      return errorResponse(
        error.code,
        "Actor activation state is invalid.",
        500,
      );
    default:
      return assertNever(error);
  }
}

export async function handleEmailChangeQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: EmailChangeQueueMessage,
): Promise<void> {
  const now = Date.now();
  const connectorId = parseConnectorId(
    gmailConnectorIdValue(body.integrationAccountId),
  );
  if (!connectorId.ok) {
    return;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    body.organisationId,
  );
  if (!execution.ok) {
    traceWarn("integration_gateway.email_change_retry", {
      requestId: body.requestId,
      reason: execution.error.code,
    });
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId: body.organisationId,
    connectorId: connectorId.value,
    placement: execution.value.placement,
    now,
  });
  if (!connector.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  const accepted = await connector.value.acceptEmailChange({
    identity: {
      organisationId: body.organisationId,
      connectorId: connectorId.value,
    },
    notificationId: body.notificationId,
    historyId: body.historyId,
    now,
  });
  if (!accepted.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  traceLog("integration_gateway.email_change_accepted", {
    requestId: body.requestId,
    organisation_id: body.organisationId,
    outcome: accepted.value.kind,
  });
}

export function slackPayloadErrorResponse(error: SlackPayloadError): Response {
  switch (error.code) {
    case "invalid_json":
      return errorResponse(error.code, "Slack body is not valid JSON.", 400);
    case "object_required":
      return errorResponse(
        error.code,
        "Slack body must be a JSON object.",
        400,
      );
    case "missing_field":
      return errorResponse(
        error.code,
        `Slack body is missing field: ${error.field}.`,
        400,
      );
    case "invalid_field":
      return errorResponse(
        error.code,
        `Slack body has invalid field: ${error.field}.`,
        400,
      );
    default:
      return assertNever(error);
  }
}
