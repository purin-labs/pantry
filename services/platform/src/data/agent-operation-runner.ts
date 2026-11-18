import { pantryCommerceAccess } from "../commerce/app-access";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { D1PreparedStatement } from "@cloudflare/workers-types";

import type { Env } from "../env";
import type { Result } from "../result";
import { buildControlAuthority } from "../request-authority";
import { parseRequestId } from "../ids";
import { processDirectCaseCommand } from "../actors/case-direct-processing";
import { readOrganisationEnvironment } from "../control/organisation-runtime";
import { resolveOrganisationCommerceMerchantBinding } from "./commerce-merchant-binding";
import {
  createPublishedResourceClient,
  resolvePublishedResponsibilityScope,
  type PublishedResourceBoundaryError,
} from "../commerce/entity-plane/published-resources";
import {
  applyAgentOperation,
  readAgentOperations,
  type AgentOperationCommand,
  type AgentOperationInput,
  type AgentOperationsError,
  type AgentOperationsSnapshot,
  type AgentResponsibilityScopePublicationEvidence,
} from "./agent-operations";
import { recordCaseAssignmentPin } from "./agent-operations/case-assignment-pins";
import { resolveManualDispatchAutomation } from "./agent-operations/automation";
import {
  authorizeOrganisationControl,
  resolveControlSessionById,
  readActiveOrganisationMembershipRevision,
  type ControlRole,
} from "./control-plane";
import type { Variant } from "@seams/type-utils";
import type { OperatorExecutionOrigin } from "../chat/turn-access";

/**
 * Whether a refusal came from resolving published-resource evidence.
 *
 * The two error families are disjoint by code, so one runner can return either
 * and each surface can still answer with the response it owes.
 */
export function isPublishedResourceBoundaryError(
  error: AgentOperationsError | PublishedResourceBoundaryError,
): error is PublishedResourceBoundaryError {
  switch (error.code) {
    case "invalid_reference":
    case "not_published":
    case "organisation_mismatch":
    case "merchant_mismatch":
    case "unavailable":
    case "revision_conflict":
      return true;
    default:
      return false;
  }
}

/** The operator and the authority that originated the command. */
export type AgentOperationActor = Readonly<{
  userId: string;
  personId: string;
  role: ControlRole;
  origin: OperatorExecutionOrigin;
}>;

/** Executes operator configuration commands for both Portal and Slack. */
export async function runAgentOperation(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    operation: AgentOperationInput;
    actor: AgentOperationActor;
    operationId: string;
    now: number;
    /** Batched with D1 effects; written after successful Case dispatch for manual runs. */
    trailing?: readonly D1PreparedStatement[];
  }>,
): Promise<
  Result<
    AgentOperationsSnapshot,
    AgentOperationsError | PublishedResourceBoundaryError
  >
> {
  if (!(await isAgentOperationAuthorized(input.env, input.scope, input.actor)))
    return { ok: false, error: { code: "unavailable" } };
  const command = await buildAgentOperationCommand({
    env: input.env,
    scope: input.scope,
    input: input.operation,
    operationId: input.operationId,
    actorUserId: input.actor.userId,
    now: input.now,
  });
  if (!command.ok) {
    return command;
  }
  if (!(await isAgentOperationAuthorized(input.env, input.scope, input.actor)))
    return { ok: false, error: { code: "unavailable" } };
  const trailing = [
    ...(input.trailing ?? []),
    input.scope.prepareMutationFence(),
  ];
  if (command.value.kind !== "dispatch_manual_run") {
    const applied = await applyAgentOperation(
      input.scope.database,
      input.scope.organisationId,
      command.value,
      trailing,
    );
    if (
      !(await isAgentOperationAuthorized(input.env, input.scope, input.actor))
    )
      return { ok: false, error: { code: "unavailable" } };
    return applied;
  }
  const dispatched = await dispatchAgentManualRun(
    input.env,
    input.scope,
    input.actor,
    command.value,
  );
  if (!dispatched.ok) {
    return dispatched;
  }
  // Case dispatch uses the stable operation ID, so a retry can safely complete
  // these receipt writes after an interruption.
  if (!(await isAgentOperationAuthorized(input.env, input.scope, input.actor)))
    return { ok: false, error: { code: "unavailable" } };
  await input.scope.database.batch([...trailing]);
  if (!(await isAgentOperationAuthorized(input.env, input.scope, input.actor)))
    return { ok: false, error: { code: "unavailable" } };
  return dispatched;
}

async function dispatchAgentManualRun(
  env: Env,
  scope: OrganisationExecutionScope,
  actor: AgentOperationActor,
  command: Variant<AgentOperationInput, "dispatch_manual_run"> & {
    readonly operationId: string;
    readonly actorUserId: string;
    readonly now: number;
  },
): Promise<Result<AgentOperationsSnapshot, AgentOperationsError>> {
  const organisationId = scope.organisationId;
  const automation = await resolveManualDispatchAutomation(
    scope.database,
    organisationId,
    command.installationId,
  );
  if (automation === null) {
    return {
      ok: false,
      error: { code: "agent_operation_not_found", field: "installationId" },
    };
  }
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: scope.database,
    organisationId: organisationId,
  });
  if (membershipRevision === null) {
    return { ok: false, error: { code: "agent_operation_persistence_failed" } };
  }
  const requestId = parseRequestId(`request_${command.operationId}`);
  if (!requestId.ok) {
    return { ok: false, error: { code: "agent_operation_persistence_failed" } };
  }
  const requestAuthority = buildControlAuthority({
    organisationId: organisationId,
    requesterPersonId: actor.personId,
    userId: actor.userId,
    membershipRevision,
    role: actor.role,
  }).requestAuthority;
  const objective = `Manual run requested by an operator.\n\n${command.instructionBody}`;
  const processed = await processDirectCaseCommand(env, {
    scope,
    projectContext: null,
    organisationId: organisationId,
    requestId: requestId.value,
    stableIdentity: `${organisationId}:manual:${command.operationId}`,
    triggerSource: { kind: "api", commandId: `command_${command.operationId}` },
    content: { kind: "text", text: objective },
    purpose: objective,
    principal: { kind: "human", principalId: actor.personId },
    requestAuthority,
    operatorOrigin: actor.origin,
    receivedAt: command.now,
    role: "coordinator",
    objective,
    delivery: { kind: "none" },
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
  });
  if (!processed.ok) {
    return { ok: false, error: { code: "agent_operation_persistence_failed" } };
  }
  await recordCaseAssignmentPin(scope, {
    organisationId: organisationId,
    assignmentId: processed.value.assignmentId,
    caseId: processed.value.caseId,
    installationId: automation.installationId,
    agentDefinitionId: automation.agentDefinitionId,
    definitionRevision: automation.definitionRevision,
    policyRevision: automation.policyRevision,
    skillRefs: automation.skillRefs,
    grantedCapabilities: automation.grantedCapabilities,
    maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
    pinnedAt: command.now,
  });
  return {
    ok: true,
    value: await readAgentOperations(scope.database, organisationId),
  };
}

async function buildAgentOperationCommand(
  input: Readonly<{
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly input: AgentOperationInput;
    readonly operationId: string;
    readonly actorUserId: string;
    readonly now: number;
  }>,
): Promise<Result<AgentOperationCommand, PublishedResourceBoundaryError>> {
  const metadata = {
    operationId: input.operationId,
    actorUserId: input.actorUserId,
    now: input.now,
  };
  if (input.input.kind !== "publish_responsibility_scope") {
    return { ok: true, value: { ...input.input, ...metadata } };
  }
  const environment = await readOrganisationEnvironment(
    input.scope.database,
    input.scope.organisationId,
  );
  if (environment === null) {
    return { ok: false, error: { code: "organisation_mismatch" } };
  }
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    environment,
  });
  if (!binding.ok) {
    return { ok: false, error: { code: "unavailable" } };
  }
  if (
    input.env.UNDERCLERK_BASE_URL === undefined ||
    input.env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return { ok: false, error: { code: "unavailable" } };
  }
  const client = createPublishedResourceClient({
    baseUrl: input.env.UNDERCLERK_BASE_URL,
    ...pantryCommerceAccess(
      input.env.UNDERCLERK_SERVICE_TOKEN,
      String(input.scope.organisationId),
      input.env.UNDERCLERK.fetch.bind(input.env.UNDERCLERK),
    ),
  });
  if (client === null) {
    return { ok: false, error: { code: "unavailable" } };
  }
  const resolved = await resolvePublishedResponsibilityScope({
    client,
    organisationId: input.scope.organisationId,
    merchantId: binding.value.merchantId,
    scope: input.input.scope,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const evidence: AgentResponsibilityScopePublicationEvidence = resolved.value;
  return {
    ok: true,
    value: {
      ...input.input,
      ...metadata,
      publishedResourceEvidence: evidence,
    },
  };
}

async function isAgentOperationAuthorized(
  env: Env,
  scope: OrganisationExecutionScope,
  actor: AgentOperationActor,
): Promise<boolean> {
  if (!(await scope.isActive())) return false;
  switch (actor.origin.kind) {
    case "slack":
      return true;
    case "control_session": {
      const session = await resolveControlSessionById({
        db: env.DB,
        controlSessionId: actor.origin.controlSessionId,
        now: Date.now(),
      });
      if (!session.ok || session.value.userId !== actor.userId) return false;
      const authority = await authorizeOrganisationControl({
        db: scope.database,
        accountAccess: scope.accountAccess,
        action: "execute",
        session: session.value,
        organisationId: scope.organisationId,
        requiredRole: "operator",
      });
      return authority.ok && (await scope.isActive());
    }
  }
}
