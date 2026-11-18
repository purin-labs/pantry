import { runtimeFetch } from "../runtime-fetch";
import { fetchWithOrganisationPlacement } from "../organisation-execution-scope";
import { storeFilePlacementCredential } from "../provider-workflows/file-context-credential";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  readScheduleDispatchReceipt,
  recordScheduleDispatchReceipt,
} from "../data/agent-operations/schedule-dispatch";
import { recordCaseAssignmentPin } from "../data/agent-operations/case-assignment-pins";
import { resolveScheduleAutomation } from "../data/agent-operations/automation";
import type { ScheduleBinding } from "../data/agent-operations";
import { processDirectCaseCommand } from "../actors/case-direct-processing";
import type { Env } from "../env";
import {
  findActiveCaseActorAtScope,
  resolveActiveCaseActorAtPlacement,
} from "../actors/actor-router";
import {
  parseIngressQueueMessage,
  type AgentScheduleDispatchQueueMessage,
} from "../ingress-queue";
import {
  newRequestId,
  parseCaseId,
  parseOrganisationId,
} from "../ids";
import {
  traceLog,
  traceWarn,
} from "../observability";
import { buildWorkflowAuthority } from "../request-authority";
import {
  handleContextProjectionQueueMessage,
  type ContextProjectionCommand,
} from "../context/projection";
import {
  ProviderFileProjectionSourceReader,
  applyFileProjectionCommand,
  type FileProjectionCommand,
} from "../context/files";
import { assertNever } from "@seams/std";
import {
  EVENT_QUEUE_RETRY_DELAY_SECONDS,
  handleCommerceDeliveryQueueMessage,
  handleEmailChangeQueueMessage,
  handleShopifyCommerceRefreshQueueMessage,
  handleCommerceOutboxReconcileQueueMessage,
  pinnedAgentForAutomation,
  queueErrorField,
} from "./support";

function scheduleRunObjective(
  binding: ScheduleBinding,
  windowKey: string,
): string {
  const fact = `Scheduled ${binding.spec.cadence} run (window ${windowKey}).`;
  return binding.instructionBody === null
    ? `${fact} Review this area's current state and prepare any work that needs attention.`
    : `${fact}\n\n${binding.instructionBody}`;
}

/**
 * A scheduled run's title: the first line of its schedule's instruction, else
 * its cadence. The Case stores it with the run's trigger, so only a reader of
 * that trigger sees it.
 */
function scheduleRunTitle(binding: ScheduleBinding): string {
  const line =
    binding.instructionBody
      ?.split("\n")
      .map((part) => part.replace(/\s+/gu, " ").trim())
      .find((part) => part.length > 0) ?? "";
  if (line.length === 0) return `Scheduled ${binding.spec.cadence} run`;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

async function handleAgentScheduleDispatchQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: AgentScheduleDispatchQueueMessage,
): Promise<void> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    body.organisationId,
  );
  if (!execution.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  const scope = execution.value;
  const existing = await readScheduleDispatchReceipt(
    scope.database,
    body.bindingId,
    body.windowKey,
  );
  if (existing !== null) {
    return;
  }
  const automation = await resolveScheduleAutomation(
    scope.database,
    body.organisationId,
    body.bindingId,
  );
  if (automation === null) {
    traceWarn("schedule_dispatch.automation_unavailable", {
      requestId: body.requestId,
      organisationId: body.organisationId,
      bindingId: body.bindingId,
      windowKey: body.windowKey,
    });
    return;
  }
  const objective = scheduleRunObjective(automation.binding, body.windowKey);
  const requestAuthority = buildWorkflowAuthority({
    organisationId: body.organisationId,
    workflowId: automation.binding.bindingId,
    workflowRevision: automation.binding.revision,
  }).requestAuthority;
  const processed = await processDirectCaseCommand(env, {
    scope,
    projectContext: null,
    organisationId: body.organisationId,
    requestId: body.requestId,
    stableIdentity: `${body.organisationId}:schedule:${body.bindingId}:${body.windowKey}`,
    triggerSource: {
      kind: "cue",
      eventId: `schedule:${body.bindingId}:${body.windowKey}`,
    },
    content: { kind: "text", text: objective },
    title: scheduleRunTitle(automation.binding),
    purpose: objective,
    principal: { kind: "system", componentId: "schedule_dispatch" },
    requestAuthority,
    receivedAt: body.receivedAt,
    role: "coordinator",
    objective,
    delivery: { kind: "none" },
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
    pinnedAgent: await pinnedAgentForAutomation(
      scope,
      body.requestId,
      automation,
    ),
  });
  if (!processed.ok) {
    traceWarn("schedule_dispatch.case_retry", {
      requestId: body.requestId,
      organisationId: body.organisationId,
      bindingId: body.bindingId,
      windowKey: body.windowKey,
      reason: processed.error.code,
    });
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  await recordCaseAssignmentPin(scope, {
    organisationId: body.organisationId,
    assignmentId: processed.value.assignmentId,
    caseId: processed.value.caseId,
    installationId: automation.binding.installationId,
    agentDefinitionId: automation.agentDefinitionId,
    definitionRevision: automation.definitionRevision,
    policyRevision: automation.policyRevision,
    skillRefs: automation.skillRefs,
    grantedCapabilities: automation.grantedCapabilities,
    maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
    pinnedAt: Date.now(),
  });
  await recordScheduleDispatchReceipt(scope.database, {
    bindingId: body.bindingId,
    windowKey: body.windowKey,
    organisationId: body.organisationId,
    caseId: processed.value.caseId,
    dispatchedAt: Date.now(),
  });
}

export async function handleEventQueueMessage(
  message: Message<unknown>,
  env: Env,
): Promise<void> {
  const parsed = parseIngressQueueMessage(message.body);

  if (!parsed.ok) {
    traceWarn("event_queue.invalid_message", {
      requestId: newRequestId(),
      message_id: message.id,
      attempts: message.attempts,
      error_code: parsed.error.code,
      field: queueErrorField(parsed.error),
    });

    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });

    return;
  }

  switch (parsed.value.type) {
    case "commerce.delivery.v1":
      await handleCommerceDeliveryQueueMessage(message, env, parsed.value);
      return;
    case "shopify.commerce_refresh.v1":
      await handleShopifyCommerceRefreshQueueMessage(
        message,
        env,
        parsed.value,
      );
      return;
    case "underclerk.outbox_reconcile.v1":
      await handleCommerceOutboxReconcileQueueMessage(
        message,
        env,
        parsed.value,
      );
      return;
    case "agent_schedule.dispatch.v1":
      await handleAgentScheduleDispatchQueueMessage(message, env, parsed.value);
      return;
    case "email.change.v1":
      await handleEmailChangeQueueMessage(message, env, parsed.value);
      return;
    case "context.projection.v1":
      await handleCaseContextProjectionQueueMessage(message, env, parsed.value);
      return;
    case "context.file_projection.v1":
      await handleFileContextProjectionQueueMessage(message, env, parsed.value);
      return;
    default:
      assertNever(parsed.value);
  }
}

async function handleFileContextProjectionQueueMessage(
  message: Message<unknown>,
  env: Env,
  command: FileProjectionCommand,
): Promise<void> {
  const requestId = newRequestId();
  const now = Date.now();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    command.organisationId,
  );
  if (!execution.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  const result = await applyFileProjectionCommand({
    scope: execution.value,
    command,
    sourceReader: new ProviderFileProjectionSourceReader({
      env,
      db: execution.value.database,
      storeCredential: storeFilePlacementCredential.bind(
        null,
        env,
        execution.value,
      ),
      command,
      fetcher: fetchWithOrganisationPlacement.bind(
        null,
        execution.value,
        runtimeFetch,
      ),
      now,
    }),
    now,
  });
  switch (result.kind) {
    case "applied":
      traceLog("event_queue.file_projection_applied", {
        requestId,
        organisationId: command.organisationId,
        grantId: command.grantId,
        integrationAccountId: command.integrationAccountId,
        provider: command.provider,
        providerFileId: command.providerFileId,
        sourceSequence: command.sourceSequence,
        segmentCount: result.segmentCount,
      });
      message.ack();
      return;
    case "duplicate":
      traceLog("event_queue.file_projection_duplicate", {
        requestId,
        organisationId: command.organisationId,
        grantId: command.grantId,
        integrationAccountId: command.integrationAccountId,
        provider: command.provider,
        providerFileId: command.providerFileId,
        sourceSequence: command.sourceSequence,
        segmentCount: result.segmentCount,
      });
      message.ack();
      return;
    case "denied":
      traceWarn("event_queue.file_projection_denied", {
        requestId,
        organisationId: command.organisationId,
        grantId: command.grantId,
        integrationAccountId: command.integrationAccountId,
        provider: command.provider,
        providerFileId: command.providerFileId,
        sourceSequence: command.sourceSequence,
        reason: result.reason,
      });
      message.ack();
      return;
    case "retry":
      traceWarn("event_queue.file_projection_retry", {
        requestId,
        organisationId: command.organisationId,
        grantId: command.grantId,
        integrationAccountId: command.integrationAccountId,
        provider: command.provider,
        providerFileId: command.providerFileId,
        sourceSequence: command.sourceSequence,
        reason: result.reason,
      });
      message.retry({
        delaySeconds:
          result.reason === "file_daily_budget_exhausted"
            ? secondsUntilNextUtcDay(now)
            : EVENT_QUEUE_RETRY_DELAY_SECONDS,
      });
  }
}

function secondsUntilNextUtcDay(now: number): number {
  const current = new Date(now);
  const next = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now) / 1_000));
}

async function handleCaseContextProjectionQueueMessage(
  message: Message<unknown>,
  env: Env,
  body: ContextProjectionCommand,
): Promise<void> {
  const caseId = parseCaseId(body.source.caseId);
  const organisationId = parseOrganisationId(body.organisationId);
  if (!caseId.ok || !organisationId.ok) {
    message.ack();
    return;
  }
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  // A Case that the registry lists as active at this scope is addressed with
  // one read. The projection only reads from it. Any other Case takes the
  // placement path, which reserves it.
  const active = await findActiveCaseActorAtScope({
    scope: scope.value,
    namespace: env.CASE,
    caseId: caseId.value,
  });
  const actor =
    active === null
      ? await resolveActiveCaseActorAtPlacement({
          env,
          placement: scope.value.placement,
          namespace: env.CASE,
          organisationId: organisationId.value,
          caseId: caseId.value,
          now: Date.now(),
        })
      : { ok: true as const, value: active };
  if (!actor.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  const result = await handleContextProjectionQueueMessage({
    db: scope.value.database,
    sourceReader: actor.value,
    message: body,
    now: Date.now(),
  });
  if (!result.ok) {
    message.retry({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
    return;
  }
  message.ack();
}
