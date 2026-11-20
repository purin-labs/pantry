import type { OrganisationDatabase } from "../database-handles";
import { pantryCommerceAccess } from "../commerce/app-access";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type {
  CommerceEntityRef,
  CommerceGraphQueryResult,
  CommerceListEntryRef,
} from "@purin-labs/commerce-contracts";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";
import type { CommerceEntityPlaneCapabilityMetadataResponse } from "@purin-labs/commerce-client";
import {
  renderCueProposal,
  type CueQueueMessage,
  type NormalizedCueEvent,
  type TierOneCueSubscription,
} from "../cues/engine";
import type { CueMutationAuthorizationOutcome } from "../cues/queue-consumer";
import { recordCaseAssignmentPin } from "../data/agent-operations/case-assignment-pins";
import { resolveCueAutomation } from "../data/agent-operations/automation";
import type {
  SavedSelectorCueResolverError,
  SavedSelectorCueResolverInput,
} from "../data/agent-operations";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import { resolveOrganisationCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import type { CueClaimResult } from "../actors/cue-delivery";
import {
  processDirectCaseCommand,
  processTwoSessionDirectCaseCommand,
  type DirectCaseCommandDelivery,
} from "../actors/case-direct-processing";
import type { Env } from "../env";
import { requireActiveOrganisationActorAtPlacement } from "../actors/actor-router";
import {
  newRequestId,
  parseConnectorId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import { traceWarn } from "../observability";
import type { Result } from "../result";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import { resolveActiveSlackDestinationConnection } from "../slack/organisation-routing";
import { buildWorkflowAuthority } from "../request-authority";
import { buildSavedSelectorCommerceReadAuthority } from "../commerce/entity-plane/authority";
import { createCommerceGraphReader } from "../commerce/entity-plane/selected-graph-reader";
import { CommerceEngineSource } from "../commerce/entity-plane/commerce-source";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  EVENT_QUEUE_RETRY_DELAY_SECONDS,
  composeTriggerInstruction,
  inventoryCasePurpose,
  pinnedAgentForAutomation,
  readOrganisationEnvironment,
} from "./support";

export const CUE_DELIVERY_LEASE_MS = 30_000;

export async function authorizeQueuedCueDelivery(
  env: Env,
  message: CueQueueMessage,
): Promise<CueMutationAuthorizationOutcome> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    message.event.organisationId,
  );
  if (!execution.ok)
    return {
      kind: "retry",
      retryAt: Date.now() + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1_000,
    };
  return { kind: "authorized" };
}

/**
 * A commerce cue that the queue is done with leaves Commerce recovery, which
 * otherwise sends it again (`readRecoverableCommerceCues`).
 */
export async function settleQueuedCue(
  env: Env,
  message: CueQueueMessage,
): Promise<void> {
  if (message.event.source !== "commerce") return;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    message.event.organisationId,
  );
  if (!execution.ok) return;
  const now = Date.now();
  const organisation = await requireActiveOrganisationActorAtPlacement({
    placement: execution.value.placement,
    env,
    organisationId: message.event.organisationId,
    now,
  });
  const settled = await organisation.settleCommerceCues({
    organisationId: message.event.organisationId,
    nativeIds: [message.event.nativeId],
    settledAt: now,
  });
  if (!settled.ok) throw new Error(settled.error.code);
}

export async function deliverMatchedCueSubscriptions(
  env: Env,
  message: CueQueueMessage,
  subscriptions: readonly TierOneCueSubscription[],
): Promise<{ kind: "complete" } | { kind: "retry"; retryAt: number }> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    message.event.organisationId,
  );
  if (!execution.ok)
    return {
      kind: "retry",
      retryAt: Date.now() + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1_000,
    };
  const scope = execution.value;
  for (const subscription of subscriptions) {
    if (!(await scope.isActive()))
      return {
        kind: "retry",
        retryAt: Date.now() + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1_000,
      };
    const delivered = await deliverMatchedCue(
      env,
      scope,
      message,
      subscription,
    );

    if (delivered.kind === "retry") {
      return delivered;
    }
  }

  return { kind: "complete" };
}

async function deliverMatchedCue(
  env: Env,
  scope: OrganisationExecutionScope,
  message: CueQueueMessage,
  subscription: TierOneCueSubscription,
): Promise<{ kind: "complete" } | { kind: "retry"; retryAt: number }> {
  const now = Date.now();
  const organisation = await requireActiveOrganisationActorAtPlacement({
    placement: scope.placement,
    env,
    organisationId: message.event.organisationId,
    now,
  });
  const claim = await organisation.claimCueDelivery({
    organisationId: message.event.organisationId,
    subscriptionId: subscription.subscriptionId,
    source: message.event.source,
    nativeId: message.event.nativeId,
    debounceMs: subscription.debounceMs,
    maxPerHour: subscription.maxPerHour,
    now,
    leaseDurationMs: CUE_DELIVERY_LEASE_MS,
  });

  if (!claim.ok) {
    return {
      kind: "retry",
      retryAt: now + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1000,
    };
  }

  switch (claim.value.kind) {
    case "duplicate":
      return { kind: "complete" };
    case "in_progress":
      return { kind: "retry", retryAt: claim.value.retryAt };
    case "suppressed":
      await writeCueLog(scope.database, {
        organisationId: message.event.organisationId,
        cueId: `${claim.value.cueId}:suppressed`,
        parentCueId: claim.value.cueId,
        event: message.event,
        decision: "store_only",
        reason: claim.value.reason,
        target: null,
        at: now,
      });
      return { kind: "complete" };
    case "claimed":
      return deliverClaimedCue(
        env,
        scope,
        message,
        subscription,
        claim.value,
        now,
      );
    default:
      return assertNever(claim.value);
  }
}

async function deliverClaimedCue(
  env: Env,
  scope: OrganisationExecutionScope,
  message: CueQueueMessage,
  subscription: TierOneCueSubscription,
  claim: Variant<CueClaimResult, "claimed">,
  now: number,
): Promise<{ kind: "complete" } | { kind: "retry"; retryAt: number }> {
  await writeCueLog(scope.database, {
    organisationId: message.event.organisationId,
    cueId: `${claim.cueId}:matched`,
    parentCueId: claim.cueId,
    event: message.event,
    decision: "matched",
    reason: subscription.subscriptionId,
    target: null,
    at: now,
  });
  return deliverClaimedCueToCase(
    env,
    scope,
    message,
    message.event,
    subscription,
    claim,
    now,
  );
}

function isDirectInventoryCaseCue(event: NormalizedCueEvent): event is Extract<
  NormalizedCueEvent,
  {
    source: "commerce";
    eventType: "inventory_shortage" | "inventory_low_stock";
  }
> {
  return (
    event.source === "commerce" &&
    (event.eventType === "inventory_shortage" ||
      event.eventType === "inventory_low_stock")
  );
}

async function deliverClaimedCueToCase(
  env: Env,
  scope: OrganisationExecutionScope,
  message: CueQueueMessage,
  event: NormalizedCueEvent,
  subscription: TierOneCueSubscription,
  claim: Variant<CueClaimResult, "claimed">,
  now: number,
): Promise<{ kind: "complete" } | { kind: "retry"; retryAt: number }> {
  const delivery = await resolveCueCaseDelivery(env, event, subscription);
  if (!delivery.ok) {
    traceWarn("integration_gateway.cue.connector_retry", {
      requestId: message.requestId,
      organisationId: event.organisationId,
      cueId: claim.cueId,
      reason: delivery.error.code,
    });
    return {
      kind: "retry",
      retryAt: now + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1000,
    };
  }
  const automation = await resolveCueAutomation(
    scope.database,
    event.organisationId,
    event.source,
    event.eventType,
    event.source === "commerce" && event.eventType === "entity_plane_changed"
      ? event.payload
      : undefined,
    event.source === "commerce" && event.eventType === "entity_plane_changed"
      ? resolveSavedSelectorCueMembership.bind(null, env, scope)
      : undefined,
  );
  const instruction = composeTriggerInstruction(
    renderCueProposal(subscription, event),
    automation?.binding.instructionBody ?? null,
  );
  const requestAuthority = buildWorkflowAuthority({
    organisationId: event.organisationId,
    workflowId: subscription.subscriptionId,
    workflowRevision: subscription.version,
  }).requestAuthority;
  const processed = isDirectInventoryCaseCue(event)
    ? await processTwoSessionDirectCaseCommand(env, {
        scope,
        projectContext: null,
        organisationId: event.organisationId,
        requestId: message.requestId,
        stableIdentity: `${event.organisationId}:cue:${event.source}:${event.nativeId}`,
        triggerSource: { kind: "cue", eventId: claim.cueId },
        content: { kind: "text", text: instruction },
        purpose: inventoryCasePurpose(event),
        principal: { kind: "system", componentId: "cue_engine" },
        requestAuthority,
        maxSessionBudgetTokens: automation?.maxSessionBudgetTokens ?? null,
        pinnedAgent: await pinnedAgentForAutomation(
          scope,
          message.requestId,
          automation,
        ),
        receivedAt: message.receivedAt,
        coordinatorObjective: `${instruction}\nUse only the supplied Case context. Do not call tools. Add one concise observation comparing immediate fulfillment and restocking options. Do not perform a provider purchase.`,
        specialistObjective: `${instruction}\nUse only the supplied Case context. Do not call tools. Add one concise inventory observation covering transfer options, replenishment quantity, timing, and operational constraints. Do not execute a commerce action.`,
        delivery: delivery.value,
      })
    : await processDirectCaseCommand(env, {
        scope,
        projectContext: null,
        organisationId: event.organisationId,
        requestId: message.requestId,
        stableIdentity: `${event.organisationId}:cue:${event.source}:${event.nativeId}`,
        triggerSource: { kind: "cue", eventId: claim.cueId },
        content: { kind: "text", text: instruction },
        purpose: instruction,
        principal: { kind: "system", componentId: "cue_engine" },
        requestAuthority,
        receivedAt: message.receivedAt,
        role: "coordinator",
        objective: instruction,
        delivery: delivery.value,
        browserContext: { kind: "unavailable" },
        surfaceContext: null,
        maxSessionBudgetTokens: automation?.maxSessionBudgetTokens ?? null,
        pinnedAgent: await pinnedAgentForAutomation(
          scope,
          message.requestId,
          automation,
        ),
      });
  if (!processed.ok) {
    if (processed.error.code === "request_authority_superseded") {
      // The subscription revision that this cue carries was replaced, so no
      // retry can pass: the cue ends as failed and the queue lets it go.
      traceWarn("integration_gateway.cue.case_refused", {
        requestId: message.requestId,
        organisationId: event.organisationId,
        cueId: claim.cueId,
        reason: processed.error.code,
      });
      const organisation = await requireActiveOrganisationActorAtPlacement({
        placement: scope.placement,
        env,
        organisationId: event.organisationId,
        now,
      });
      await organisation.completeClaimedCueDelivery({
        organisationId: event.organisationId,
        cueId: claim.cueId,
        leaseId: claim.leaseId,
        outcome: "failed",
        now,
      });
      return { kind: "complete" };
    }
    traceWarn("integration_gateway.cue.case_retry", {
      requestId: message.requestId,
      organisationId: event.organisationId,
      cueId: claim.cueId,
      reason: processed.error.code,
    });
    return {
      kind: "retry",
      retryAt: now + EVENT_QUEUE_RETRY_DELAY_SECONDS * 1000,
    };
  }
  if (automation !== null) {
    const assignmentIds =
      "assignmentIds" in processed.value
        ? processed.value.assignmentIds
        : [processed.value.assignmentId];
    for (const assignmentId of assignmentIds) {
      await recordCaseAssignmentPin(scope, {
        organisationId: event.organisationId,
        assignmentId,
        caseId: processed.value.caseId,
        installationId: automation.binding.installationId,
        agentDefinitionId: automation.agentDefinitionId,
        definitionRevision: automation.definitionRevision,
        policyRevision: automation.policyRevision,
        skillRefs: automation.skillRefs,
        grantedCapabilities: automation.grantedCapabilities,
        maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
        pinnedAt: now,
      });
    }
  }
  await completeAndLogCaseCue(
    env,
    scope,
    event,
    claim,
    processed.value.caseId,
    now,
  );
  return { kind: "complete" };
}

async function resolveSavedSelectorCueMembership(
  env: Env,
  scope: OrganisationExecutionScope,
  input: SavedSelectorCueResolverInput,
): Promise<Result<boolean, SavedSelectorCueResolverError>> {
  if (input.selector.query.kind !== "saved_commerce_view") {
    return { ok: false, error: { code: "saved_selector_resolver_failed" } };
  }
  try {
    const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: input.organisationId,
    });
    if (!commerceAuthority.ok) {
      return savedSelectorResolverFailure();
    }
    const environment = await readOrganisationEnvironment(
      scope.database,
      input.organisationId,
    );
    const binding = await resolveOrganisationCommerceMerchantBinding({
      db: scope.database,
      organisationId: input.organisationId,
      environment,
    });
    if (!binding.ok) {
      return savedSelectorResolverFailure();
    }
    if (
      commerceAuthority.value.commerceSystem.kind === "satyr_commerce" &&
      commerceAuthority.value.commerceSystem.merchantId !==
        binding.value.merchantId
    ) {
      return savedSelectorResolverFailure();
    }
    if (
      env.UNDERCLERK_BASE_URL === undefined ||
      env.UNDERCLERK_SERVICE_TOKEN === undefined
    ) {
      return savedSelectorResolverFailure();
    }
    const client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(input.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
      ),
    });
    const metadata = await client.capabilityMetadata({
      organisationId: String(input.organisationId),
      merchantId: String(binding.value.merchantId),
      query: input.selector.query,
    });
    if (!metadata.ok) {
      return savedSelectorResolverFailure();
    }
    if (
      String(metadata.value.organisationId) !== String(input.organisationId) ||
      String(metadata.value.merchantId) !== String(binding.value.merchantId)
    ) {
      return savedSelectorResolverFailure();
    }
    if (!savedSelectorCapabilityMatches(input, metadata.value.capabilities)) {
      return { ok: true, value: false };
    }
    const commerceEngine = new CommerceEngineSource({
      organisationId: String(input.organisationId),
      merchantId: String(binding.value.merchantId),
      integrationAccountId: String(binding.value.integrationAccountId),
      client,
    });
    const reader = await createCommerceGraphReader({
      commerceSystem: commerceAuthority.value.commerceSystem,
      organisationId: input.organisationId,
      merchantId: String(binding.value.merchantId),
      underclerk: commerceEngine,
      organisation: () =>
        requireActiveOrganisationActorAtPlacement({
          placement: scope.placement,
          env,
          organisationId: input.organisationId,
          now: Date.now(),
        }),
    });
    const authority = buildSavedSelectorCommerceReadAuthority({
      organisationId: String(input.organisationId),
      merchantId: String(binding.value.merchantId),
      principalId: "cue_engine",
      sensitivityCeiling: "restricted",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      commandId: newRequestId(),
      selectorId: input.selector.selectorId,
      selectorRevision: input.selector.revision,
      query: input.selector.query,
    });
    if (!authority.ok) {
      return savedSelectorResolverFailure();
    }
    const read = await reader.query({
      query: input.selector.query,
      authority: authority.value,
      now: new Date().toISOString(),
    });
    if (!read.ok) {
      return savedSelectorResolverFailure();
    }
    return {
      ok: true,
      value: savedSelectorObservationMatches(read.value, input.observation),
    };
  } catch {
    return savedSelectorResolverFailure();
  }
}

function savedSelectorCapabilityMatches(
  input: SavedSelectorCueResolverInput,
  capabilities: CommerceEntityPlaneCapabilityMetadataResponse["capabilities"],
): boolean {
  if (capabilities.kind !== "saved_commerce_view") {
    return false;
  }
  if (input.selector.query.kind !== "saved_commerce_view") {
    return false;
  }
  return (
    String(capabilities.viewId) === input.selector.selectorId &&
    String(capabilities.viewId) === String(input.selector.query.viewId) &&
    Number(capabilities.viewRevision) === input.selector.revision
  );
}

function savedSelectorObservationMatches(
  result: CommerceGraphQueryResult,
  observation: SavedSelectorCueResolverInput["observation"],
): boolean {
  switch (observation.kind) {
    case "system_entity_changed":
    case "custom_entity_changed":
      return result.entities.some(
        entityContainsObservationRef.bind(null, observation.entityRef),
      );
    case "commerce_list_entry_changed":
      return result.listEntries.some(
        listEntryContainsObservation.bind(null, observation),
      );
    case "relationship_changed":
      return false;
    default:
      return assertNever(observation);
  }
}

function entityContainsObservationRef(
  observationRef: CommerceEntityRef,
  entity: CommerceGraphQueryResult["entities"][number],
): boolean {
  return sameCommerceEntityRef(entity.reference, observationRef);
}

function listEntryContainsObservation(
  observation: Variant<
    SavedSelectorCueResolverInput["observation"],
    "commerce_list_entry_changed"
  >,
  entry: CommerceGraphQueryResult["listEntries"][number],
): boolean {
  return (
    sameCommerceListEntryRef(entry, observation.entry) &&
    sameCommerceEntityRef(entry.entityRef, observation.entityRef)
  );
}

function sameCommerceEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function sameCommerceListEntryRef(
  left: CommerceListEntryRef,
  right: CommerceListEntryRef,
): boolean {
  return (
    left.entryId === right.entryId &&
    left.listId === right.listId &&
    left.revision === right.revision
  );
}

function savedSelectorResolverFailure(): Result<
  never,
  SavedSelectorCueResolverError
> {
  return { ok: false, error: { code: "saved_selector_resolver_failed" } };
}

async function resolveCueCaseDelivery(
  env: Env,
  event: NormalizedCueEvent,
  subscription: TierOneCueSubscription,
): Promise<Result<DirectCaseCommandDelivery, { readonly code: string }>> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return { ok: false, error: { code: installationIdentity.error.code } };
  }
  const destination = await resolveActiveSlackDestinationConnection(env, {
    ...installationIdentity.value,
    organisationId: event.organisationId,
    workspaceId: subscription.surfaceScope.workspaceId,
    channelId: subscription.surfaceScope.channelId,
  });
  if (!destination.ok) {
    return { ok: false, error: { code: "cue_connector_install_unavailable" } };
  }
  const connectorId = parseConnectorId(
    `connector_slack_${destination.value.integrationAccountId}`,
  );
  if (!connectorId.ok) {
    return { ok: false, error: { code: "cue_connector_identity_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "connector",
      connectorId: connectorId.value,
      address: {
        kind: "slack_channel",
        workspaceId: subscription.surfaceScope.workspaceId,
        channelId: subscription.surfaceScope.channelId,
      },
    },
  };
}

async function completeAndLogCaseCue(
  env: Env,
  scope: OrganisationExecutionScope,
  event: NormalizedCueEvent,
  claim: { readonly cueId: string; readonly leaseId: string },
  caseId: string,
  now: number,
): Promise<void> {
  const organisation = await requireActiveOrganisationActorAtPlacement({
    placement: scope.placement,
    env,
    organisationId: event.organisationId,
    now,
  });
  await organisation.completeClaimedCueDelivery({
    organisationId: event.organisationId,
    cueId: claim.cueId,
    leaseId: claim.leaseId,
    outcome: "proposed",
    now,
  });
  await writeCueLog(scope.database, {
    organisationId: event.organisationId,
    cueId: `${claim.cueId}:proposed`,
    parentCueId: claim.cueId,
    event,
    decision: "proposed",
    reason: `case:${caseId}`,
    target: { kind: "case", caseId },
    at: now,
  });
}

type CueDeliveryLogInput = {
  organisationId: OrganisationId;
  cueId: string;
  parentCueId: string;
  event: NormalizedCueEvent;
  reason: string;
  at: number;
} & (
  | {
      decision: "matched" | "store_only";
      target: null;
    }
  | {
      decision: "proposed";
      target:
        | { readonly kind: "slack"; readonly threadId: string }
        | { readonly kind: "case"; readonly caseId: string };
    }
);

async function writeCueLog(
  db: OrganisationDatabase,
  input: CueDeliveryLogInput,
): Promise<void> {
  const target = cueDeliveryTarget(input);
  await db
    .prepare(
      `INSERT OR IGNORE INTO cue_log (
         organisation_id, integration_account_id, cue_id, source, native_id,
         decision, reason, session_id, at,
         parent_cue_id, surface_kind, surface_thread_id, actor_person_id,
         response_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      input.organisationId,
      cueLogIntegrationAccountId(input.event),
      input.cueId,
      input.event.source,
      input.event.nativeId,
      input.decision,
      input.reason,
      input.at,
      input.parentCueId,
      target.surfaceKind,
      target.threadId,
    )
    .run();
}

export function cueLogIntegrationAccountId(
  event: NormalizedCueEvent,
): IntegrationAccountId | null {
  return event.source === "commerce" &&
    event.eventType !== "entity_plane_changed"
    ? null
    : event.integrationAccountId;
}

function cueDeliveryTarget(input: CueDeliveryLogInput): {
  surfaceKind: "slack" | null;
  threadId: string | null;
} {
  switch (input.decision) {
    case "matched":
    case "store_only":
      return { surfaceKind: null, threadId: null };
    case "proposed":
      switch (input.target.kind) {
        case "slack":
          return { surfaceKind: "slack", threadId: input.target.threadId };
        case "case":
          return { surfaceKind: null, threadId: null };
        default:
          return assertNever(input.target);
      }
    default:
      return assertNever(input);
  }
}
