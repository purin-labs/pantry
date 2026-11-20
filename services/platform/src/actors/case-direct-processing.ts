import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import { acceptedExecutionAccountAuthority } from "../account-platform/access";
import type { TurnMemoryReader } from "../context/assembly";
import { turnMemoryReaderWithoutSubjects } from "../memory/access";
import type { CompiledTurnAuthority } from "../authorization/access-grants/turn-authority";
import type { ContextAssemblyResult } from "../context/assembly";
import { admitProjectContext } from "../projects/context";
import { admitChatInput } from "../chat/input-admission";
import {
  authorizeSessionTurnExecution,
  bindOperatorTurnAccess,
  type OperatorExecutionOrigin,
} from "../chat/turn-access";
import type { ProjectSnapshot } from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type {
  AgentRole,
  CaseAssignmentLifecycle,
  CaseContent,
  CaseTriggerSource,
  ConnectorAddress,
  ConnectorIdentity,
  EventPrincipal,
  RequestAuthority,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";

import {
  parseAssignmentId,
  parseSessionId,
  type AssignmentId,
  type CaseId,
  type ConnectorId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "../ids";
import {
  digestModelRoute,
  resolveOrganisationModelRouteAtScope,
  selectOrganisationChatModel,
  type OrganisationModelRoute,
} from "../models/route";
import {
  loadOrganisationPolicyOrDefaultDeny,
  type PinnedSessionPolicy,
} from "../policy-snapshot";
import type { Result } from "../result";
import { ensureOrganisationDefaultWorkspace } from "../data/organisation-workspace";
import { deriveStableCaseId } from "../case-identity";
import { ensureCaseProject } from "../projects/case-project";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActor,
  resolveActiveSessionActorAtPlacement,
  resolveActiveSessionActorAtScope,
  resolveActiveCaseSessionActorsAtScope,
  publishActorRegistryActivation,
} from "./actor-router";
import {
  finalizeAssignedCaseSession,
  runDirectCasePath,
  runDirectTwoSessionCasePath,
  type DirectCasePathResult,
  type DirectCasePathInput,
  type DirectCaseDelivery,
  type DirectTwoSessionCasePathResult,
  type CaseWalkingPathError,
} from "./case-walking-path";
import type { EmbeddedHarnessThinkingLevel } from "./embedded-harness";
import {
  prepareTurnContextRead,
  prepareTurnAuthority,
  prepareTurnContext,
} from "../context/turn-context";
import type { PinnedAgentProfile } from "../data/pinned-agent-profile";
import type { BakerySurfaceAttachmentV1 } from "@purin-labs/bakery-model/bakery-surface";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { traceLog } from "../observability";
import type { SessionActor } from "./session/session-actor";
import {
  recoverAbandonedAssignments,
  sessionQuiescenceProver,
} from "./case/abandoned-assignments";
import type { CaseDO } from "./case";

export type ConversationCaseActor = DirectCasePathInput["caseActor"] &
  Pick<CaseDO, "readTail">;

type DirectCaseIdentities = VariantBy<
  Awaited<ReturnType<typeof deriveDirectCaseIdentities>>,
  "ok",
  true
>["value"];

type PreparedDirectCaseContext = {
  readonly policy: PinnedSessionPolicy;
  readonly authority: CompiledTurnAuthority;
  readonly context: ContextAssemblyResult;
};

type DirectCaseResources = {
  readonly scope: OrganisationExecutionScope;
  readonly workspace: WorkspaceRevisionReceipt;
  readonly policy: PinnedSessionPolicy;
};

type DirectCaseCommand = {
  readonly scope: OrganisationExecutionScope;
  readonly projectContext: ProjectSnapshot | null;
  readonly organisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly stableIdentity: string;
  readonly triggerSource: Exclude<
    CaseTriggerSource,
    { readonly kind: "connector" }
  >;
  readonly content: CaseContent;
  /** What the trigger is about, shown under the trigger's label. */
  readonly title?: string;
  readonly purpose: string;
  readonly principal: EventPrincipal;
  readonly requestAuthority: RequestAuthority;
  readonly receivedAt: number;
  readonly role: AgentRole;
  readonly objective: string;
  readonly delivery: DirectCaseCommandDelivery;
  readonly maxSessionBudgetTokens?: number | null;
  readonly requiredModelRoute?: OrganisationModelRoute;
  readonly thinkingLevel?: EmbeddedHarnessThinkingLevel;
  readonly browserContext: BakeryBrowserContext;
  readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
  /** The installed agent this run was resolved for, when an automation owns it. */
  readonly pinnedAgent?: PinnedAgentProfile | null;
  /**
   * The Memory reader of this turn, from the surface that knows its subject
   * and its destination audience. A Portal conversation passes one. A turn
   * with no verified subject passes none and reads no Memory.
   */
  readonly memoryReader?: TurnMemoryReader;
};

export type DirectCaseCommandDelivery =
  | { readonly kind: "none" }
  | {
      readonly kind: "connector";
      readonly connectorId: ConnectorId;
      readonly address: ConnectorAddress;
    };

type DirectCaseCommandResult = DirectCasePathResult & {
  readonly caseId: string;
  readonly sessionId: string;
  readonly assignmentId: string;
};

type TwoSessionDirectCaseCommand = Omit<
  DirectCaseCommand,
  "role" | "objective" | "surfaceContext" | "browserContext"
> & {
  readonly coordinatorObjective: string;
  readonly specialistObjective: string;
  /**
   * When present, a third assignment starts after both participants ended.
   * It is given what both proposed and makes one proposal from them.
   */
  readonly combinedObjective?: string;
};

/**
 * Caps the pinned session policy budget with a merchant-configured
 * per-installation ceiling. Governance can only tighten the policy budget.
 */
function capDirectCasePolicyBudget(
  policy: PinnedSessionPolicy,
  maxSessionBudgetTokens: number | null,
): PinnedSessionPolicy {
  if (maxSessionBudgetTokens === null) {
    return policy;
  }
  const current = policy.authz.maxBudget;
  return {
    ...policy,
    authz: {
      ...policy.authz,
      maxBudget: {
        maxTokens:
          current?.maxTokens === undefined || current.maxTokens === null
            ? maxSessionBudgetTokens
            : Math.min(current.maxTokens, maxSessionBudgetTokens),
        maxWallMs: current?.maxWallMs ?? null,
        maxToolCalls: current?.maxToolCalls ?? null,
      },
    },
  };
}

type TwoSessionDirectCaseCommandResult = DirectTwoSessionCasePathResult & {
  readonly caseId: string;
  readonly sessionIds: readonly [string, string];
  readonly assignmentIds: readonly [string, string];
  readonly combinedAssignmentId: string | null;
};

export type DirectCaseCommandError =
  | Variant<CaseWalkingPathError, "budget_exhausted">
  | {
      readonly code: string;
      readonly kind: "operational";
      readonly exhaustion?: never;
      readonly budget?: never;
    };

export async function processDirectCaseCommand(
  env: Env,
  command: DirectCaseCommand &
    (
      | {
          readonly requestAuthority: Variant<RequestAuthority, "control">;
          readonly operatorOrigin: OperatorExecutionOrigin;
        }
      | {
          readonly requestAuthority: Exclude<
            RequestAuthority,
            { kind: "control" }
          >;
          readonly operatorOrigin?: never;
        }
    ),
): Promise<Result<DirectCaseCommandResult, DirectCaseCommandError>> {
  const scope = command.scope;
  if (
    scope.organisationId !== command.organisationId ||
    !(await scope.isActive())
  )
    return failure("organisation_placement_conflict");
  const identities = await deriveDirectCaseIdentities(command.stableIdentity);
  if (!identities.ok) return identities;
  const placed = await ensureCaseProject({
    scope,
    caseId: identities.value.caseId,
    origin: "direct",
    now: command.receivedAt,
  });
  if (!placed.ok) return failure(placed.error.code);
  if (command.operatorOrigin !== undefined) {
    const bound = await bindOperatorTurnAccess(
      scope,
      identities.value.sessionId,
      `turn_trigger_${identities.value.digest}`,
      command.requestAuthority,
      command.operatorOrigin,
    );
    if (!bound) return failure("session_origin_conflict");
  }
  const [actors, resources] = await Promise.all([
    resolveActiveCaseSessionActorsAtScope({
      scope,
      caseNamespace: env.CASE,
      sessionNamespace: env.SESSION,
      caseId: identities.value.caseId,
      sessionId: identities.value.sessionId,
      now: command.receivedAt,
    }),
    prepareDirectCaseResources(env, command),
  ]);
  if (!actors.ok) return failure(actors.error.code);
  const published = await publishActorRegistryActivation({
    env,
    publication: actors.value.registryActivation,
  });
  if (!published.ok) return failure(published.error.code);
  if (!resources.ok) return resources;
  // A delivery that comes back to its own work finds its turn first
  // (Refactor 15, refactor 9): a finished turn gives its answer, and an
  // assignment that nothing will finish ends.
  const recovered = await recoverDirectCaseTurn(
    resources.value.scope,
    env,
    command,
    identities.value.caseId,
    identities.value,
    actors.value.sessionActor,
    actors.value.caseActor,
    resources.value.policy,
    "command",
  );
  if (recovered !== null) return recovered;
  const prepared = await prepareDirectCaseContext(
    env,
    command,
    identities.value,
    actors.value.caseActor,
    resources.value,
  );
  if (!prepared.ok) return prepared;
  return processDirectCaseWithIdentities(
    env,
    command,
    identities.value,
    actors.value.sessionActor,
    actors.value.caseActor,
    resources.value,
    prepared.value,
  );
}

type ConversationCaseCommand = Omit<
  DirectCaseCommand,
  "delivery" | "requiredModelRoute"
> & {
  readonly delivery: { readonly kind: "none" };
  readonly requiredModelRoute: OrganisationModelRoute;
};

export async function processConversationCaseCommand(
  env: Env,
  command: ConversationCaseCommand,
  conversationIdentity: string,
  caseActor: ConversationCaseActor,
): Promise<Result<DirectCaseCommandResult, DirectCaseCommandError>> {
  const turn = await deriveDirectCaseIdentities(command.stableIdentity);
  if (!turn.ok) return turn;
  const conversation = await deriveDirectCaseIdentities(conversationIdentity);
  if (!conversation.ok) return conversation;
  const identities: DirectCaseIdentities = {
    caseId: conversation.value.caseId,
    sessionId: turn.value.sessionId,
    assignmentId: turn.value.assignmentId,
    digest: turn.value.digest,
  };
  const recoveryStartedAt = Date.now();
  const [session, preparation] = await Promise.all([
    resolveActiveSessionActorAtScope({
      namespace: env.SESSION,
      scope: command.scope,
      sessionId: turn.value.sessionId,
      now: command.receivedAt,
    }),
    prepareConversationCaseContext(env, command, identities, caseActor),
  ]);
  if (!session.ok) return failure(session.error.code);
  if (!preparation.ok) return preparation;
  const { resources, prepared } = preparation.value;
  const recovered = await recoverDirectCaseTurn(
    resources.scope,
    env,
    command,
    conversation.value.caseId,
    turn.value,
    session.value,
    caseActor,
    resources.policy,
    "conversation",
  );
  traceDirectCasePreparation(command, "recovery", recoveryStartedAt);
  if (recovered !== null) return recovered;
  if (!prepared.ok) return prepared;
  return processDirectCaseWithIdentities(
    env,
    command,
    identities,
    session.value,
    caseActor,
    resources,
    prepared.value,
  );
}

/**
 * Reads the Session's turn of a command that was delivered before. A chat's
 * turn that runs answers that it runs, and a completed turn finishes the command
 * with its answer. A turn that failed, or a turn that never started under an
 * assignment that nothing moves, ends the assignment as abandoned, on the
 * Session's proof that it runs no turn; the command then fails. Null: no
 * earlier delivery left a turn, and the command runs.
 */
async function recoverDirectCaseTurn(
  scope: OrganisationExecutionScope,
  env: Env,
  command: DirectCaseCommand,
  caseId: CaseId,
  turn: {
    readonly sessionId: SessionId;
    readonly assignmentId: AssignmentId;
    readonly digest: string;
  },
  session: Pick<SessionActor, "inspectTurnStream" | "readCompletedTurn">,
  caseActor: ConversationCaseActor,
  policy: PinnedSessionPolicy,
  surface: "conversation" | "command",
): Promise<Result<DirectCaseCommandResult, DirectCaseCommandError> | null> {
  const turnId = `turn_trigger_${turn.digest}`;
  const state = await session.inspectTurnStream({
    organisationId: command.organisationId,
    turnId,
  });
  if (!state.ok) return failure(state.error.code);
  // A chat waits for its running turn. A command's delivery drives a turn
  // that its stopped process left (`runDirectCasePath`).
  if (state.value.kind === "present" && state.value.state === "running")
    return surface === "conversation"
      ? failure("conversation_turn_running")
      : null;
  // The Case's duplicate trigger ends an assignment whose turn never
  // started (`runDirectCasePath`).
  if (state.value.kind === "missing") return null;
  if (state.value.state === "failed") {
    // The turn has ended, so its assignment ends now. Each later delivery
    // gets the same answer: the turn failed.
    await abandonOwnAssignment(scope, env, caseActor, turn.assignmentId);
    return failure(
      surface === "conversation"
        ? "conversation_turn_failed"
        : "case_turn_failed",
    );
  }
  // A completed turn's answer reaches a connector only through its own
  // delivery, so such a command waits for the Case's alarm.
  if (command.delivery.kind !== "none") return null;
  const completion = await session.readCompletedTurn({
    organisationId: command.organisationId,
    sessionId: turn.sessionId,
    turnId,
  });
  if (!completion.ok) return failure(completion.error.code);
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) return failure(snapshot.error.code);
  const lifecycle = snapshot.value.assignmentLifecycles.find(
    assignmentMatches.bind(null, turn.assignmentId),
  );
  if (lifecycle === undefined || lifecycle.kind === "assigned")
    return failure("case_assignment_missing");
  const revalidate = prepareDirectTurnAuthority.bind(null, {
    globalDatabase: env.DB,
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(turn.sessionId, turnId),
    action: "execute",
    organisationId: command.organisationId,
    requestAuthority: command.requestAuthority,
    policy,
    sessionId: turn.sessionId,
    turnId,
  });
  const authority = await revalidate();
  if (!authority.ok) return failure(authority.error.code);
  if (
    authority.value.authorityPartition.digest !==
    lifecycle.assignment.authorityPartition.digest
  )
    return failure("case_authority_partition_changed");
  const finalized = await finalizeAssignedCaseSession(
    {
      env,
      caseActor,
      turnAuthority: authority.value,
      receivedAt: lifecycle.start.acceptedAt,
      delivery: { kind: "none" },
      revalidateTurnAuthority: revalidate,
    },
    lifecycle.assignment,
    turnId,
    completion.value,
  );
  if (!finalized.ok) return failure(finalized.error.code);
  return {
    ok: true,
    value: {
      kind: "completed",
      ...finalized.value,
      caseId,
      sessionId: turn.sessionId,
      assignmentId: turn.assignmentId,
    },
  };
}

function assignmentMatches(
  assignmentId: AssignmentId,
  lifecycle: CaseAssignmentLifecycle,
): boolean {
  return lifecycle.assignment.assignmentId === assignmentId;
}

/** Ends the command's own assignment, whose turn failed. */
async function abandonOwnAssignment(
  scope: OrganisationExecutionScope,
  env: Env,
  caseActor: ConversationCaseActor,
  assignmentId: AssignmentId,
): Promise<void> {
  await recoverAbandonedAssignments({
    caseActor,
    proveQuiescence: sessionQuiescenceProver(env, scope),
    minimumAgeMs: 0,
    now: Date.now(),
    mayAbandon: assignmentMatches.bind(null, assignmentId),
  });
}

async function prepareDirectCaseResources(
  env: Env,
  command: DirectCaseCommand,
): Promise<Result<DirectCaseResources, DirectCaseCommandError>> {
  const scope = command.scope;
  if (scope.organisationId !== command.organisationId)
    return failure("organisation_placement_conflict");
  const preparationStartedAt = Date.now();
  const [workspace, policy] = await Promise.all([
    ensureOrganisationDefaultWorkspace({
      scope: scope,
      archive: env.ARCHIVE,
      now: command.receivedAt,
    }),
    loadDirectCasePolicy(
      scope,
      env,
      command.organisationId,
      command.receivedAt,
      command.requiredModelRoute ?? null,
    ),
  ]);
  traceDirectCasePreparation(command, "workspace_policy", preparationStartedAt);
  if (!workspace.ok) return failure(workspace.error.code);
  if (!policy.ok) return policy;
  return {
    ok: true,
    value: { scope: scope, workspace: workspace.value, policy: policy.value },
  };
}

async function prepareConversationCaseContext(
  env: Env,
  command: ConversationCaseCommand,
  identities: DirectCaseIdentities,
  caseActor: ConversationCaseActor,
): Promise<
  Result<
    {
      readonly resources: DirectCaseResources;
      readonly prepared: Result<
        PreparedDirectCaseContext,
        DirectCaseCommandError
      >;
    },
    DirectCaseCommandError
  >
> {
  const resources = await prepareDirectCaseResources(env, command);
  if (!resources.ok) return resources;
  const prepared = await prepareDirectCaseContext(
    env,
    command,
    identities,
    caseActor,
    resources.value,
  );
  // Saved-turn recovery uses its own authority check and can ignore a context error.
  return { ok: true, value: { resources: resources.value, prepared } };
}

async function prepareDirectCaseContext(
  env: Env,
  command: DirectCaseCommand,
  identities: DirectCaseIdentities,
  caseActor: ConversationCaseActor,
  resources: DirectCaseResources,
): Promise<Result<PreparedDirectCaseContext, DirectCaseCommandError>> {
  const cappedPolicy = capDirectCasePolicyBudget(
    resources.policy,
    command.maxSessionBudgetTokens ?? null,
  );
  const authorityStartedAt = Date.now();
  const [authorized, permit] = await Promise.all([
    authorizeDirectTurnExecution({
      globalDatabase: env.DB,
      db: resources.scope.database,
      accountAccess: resources.scope.accountAccess,
      organisationId: command.organisationId,
      requestAuthority: command.requestAuthority,
      sessionId: identities.sessionId,
      turnId: `turn_trigger_${identities.digest}`,
    }),
    prepareTurnContextRead({
      db: resources.scope.database,
      accountAccess: resources.scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(
        identities.sessionId,
        identities.assignmentId,
      ),
      action: "execute",
      organisationId: command.organisationId,
      caseId: identities.caseId,
      assignmentId: identities.assignmentId,
      sessionId: identities.sessionId,
      requestAuthority: command.requestAuthority,
      policy: cappedPolicy,
      query: command.purpose,
      now: command.receivedAt,
      tailReader: caseActor,
      // With no reader from its surface, the turn has no verified subject,
      // so no Memory scope can match.
      memoryReader: command.memoryReader ?? turnMemoryReaderWithoutSubjects(),
    }),
  ]);
  traceDirectCasePreparation(command, "turn_authority", authorityStartedAt);
  if (!authorized) return failure("chat_access_revoked");
  if (!permit.ok) return failure(permit.error.code);
  const contextStartedAt = Date.now();
  const preparedContext = await admitChatInput(
    resources.scope.database,
    command.requestAuthority,
    permit.value,
    `turn_trigger_${identities.digest}`,
    command.content,
    command.receivedAt,
  );
  traceDirectCasePreparation(command, "authorized_context", contextStartedAt);
  if (!preparedContext.ok) return failure(preparedContext.error.code);
  return {
    ok: true,
    value: {
      policy: cappedPolicy,
      authority: permit.value.turnAuthority,
      context: preparedContext.value,
    },
  };
}

async function processDirectCaseWithIdentities(
  env: Env,
  command: DirectCaseCommand,
  identities: DirectCaseIdentities,
  session: DirectCasePathInput["session"],
  caseActor: ConversationCaseActor,
  resources: DirectCaseResources,
  prepared: PreparedDirectCaseContext,
): Promise<Result<DirectCaseCommandResult, DirectCaseCommandError>> {
  const delivery = await resolveDirectCaseDelivery(
    env,
    command.organisationId,
    identities.caseId,
    command.delivery,
    command.receivedAt,
  );
  if (!delivery.ok) return delivery;
  const admittedContext = await admitProjectContext(
    resources.scope.database,
    resources.scope.accountAccess,
    command.requestAuthority,
    prepared.context,
    command.projectContext,
  );
  const result = await runDirectCasePath({
    env,
    pinnedAgent: command.pinnedAgent ?? null,
    caseActor,
    session,
    organisationId: command.organisationId,
    requestId: command.requestId,
    sessionId: identities.sessionId,
    caseId: identities.caseId,
    triggerId: `trigger_${identities.digest}`,
    triggerSource: command.triggerSource,
    content: command.content,
    ...(command.title === undefined ? {} : { title: command.title }),
    assignmentId: identities.assignmentId,
    purpose: command.purpose,
    principal: command.principal,
    policy: prepared.policy,
    workspaceRevisionReceipt: resources.workspace,
    receivedAt: command.receivedAt,
    role: command.role,
    objective: command.objective,
    delivery: delivery.value,
    turnAuthority: prepared.authority,
    revalidateTurnAuthority: prepareDirectTurnAuthority.bind(null, {
      globalDatabase: env.DB,
      db: resources.scope.database,
      accountAccess: resources.scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(
        identities.sessionId,
        `turn_trigger_${identities.digest}`,
      ),
      action: "execute",
      organisationId: command.organisationId,
      requestAuthority: command.requestAuthority,
      policy: prepared.policy,
      sessionId: identities.sessionId,
      turnId: `turn_trigger_${identities.digest}`,
    }),
    context: admittedContext,
    projectContext: command.projectContext,
    thinkingLevel: command.thinkingLevel,
    browserContext: command.browserContext,
    surfaceContext: command.surfaceContext,
  });
  if (!result.ok)
    return result.error.kind === "budget_exhausted"
      ? { ok: false, error: result.error }
      : failure(result.error.code);
  return {
    ok: true,
    value: {
      ...result.value,
      caseId: identities.caseId,
      sessionId: identities.sessionId,
      assignmentId: identities.assignmentId,
    },
  };
}

function traceDirectCasePreparation(
  command: Pick<DirectCaseCommand, "requestId" | "organisationId">,
  phase:
    "recovery" | "workspace_policy" | "turn_authority" | "authorized_context",
  startedAt: number,
): void {
  traceLog("case.direct_preparation_timing", {
    requestId: command.requestId,
    organisation_id: command.organisationId,
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

export async function processTwoSessionDirectCaseCommand(
  env: Env,
  command: TwoSessionDirectCaseCommand,
): Promise<Result<TwoSessionDirectCaseCommandResult, DirectCaseCommandError>> {
  const scope = command.scope;
  if (
    scope.organisationId !== command.organisationId ||
    !(await scope.isActive())
  )
    return failure("organisation_placement_conflict");
  const base = await deriveDirectCaseIdentities(command.stableIdentity);
  if (!base.ok) return base;
  const coordinator = deriveParticipantIdentities(
    base.value.digest,
    "coordinator",
  );
  const specialist = deriveParticipantIdentities(
    base.value.digest,
    "specialist",
  );
  if (!coordinator.ok) return coordinator;
  if (!specialist.ok) return specialist;
  const combined =
    command.combinedObjective === undefined
      ? null
      : deriveParticipantIdentities(base.value.digest, "combined");
  if (combined !== null && !combined.ok) return combined;
  const placed = await ensureCaseProject({
    scope,
    caseId: base.value.caseId,
    origin: "direct",
    now: command.receivedAt,
  });
  if (!placed.ok) return failure(placed.error.code);
  const workspace = await ensureOrganisationDefaultWorkspace({
    scope: scope,
    archive: env.ARCHIVE,
    now: command.receivedAt,
  });
  if (!workspace.ok) return failure(workspace.error.code);
  const policy = await loadDirectCasePolicy(
    scope,
    env,
    command.organisationId,
    command.receivedAt,
    command.requiredModelRoute ?? null,
  );
  if (!policy.ok) return policy;
  const cappedPolicy = capDirectCasePolicyBudget(
    policy.value,
    command.maxSessionBudgetTokens ?? null,
  );
  const [caseActor, coordinatorSession, specialistSession] = await Promise.all([
    resolveActiveCaseActorAtPlacement({
      env: env,
      namespace: env.CASE,
      placement: command.scope.placement,
      organisationId: command.organisationId,
      caseId: base.value.caseId,
      now: command.receivedAt,
    }),
    resolveActiveSessionActorAtPlacement({
      env: env,
      namespace: env.SESSION,
      placement: command.scope.placement,
      organisationId: command.organisationId,
      sessionId: coordinator.value.sessionId,
      now: command.receivedAt,
    }),
    resolveActiveSessionActorAtPlacement({
      env: env,
      namespace: env.SESSION,
      placement: command.scope.placement,
      organisationId: command.organisationId,
      sessionId: specialist.value.sessionId,
      now: command.receivedAt,
    }),
  ]);
  if (!caseActor.ok) return failure(caseActor.error.code);
  if (!coordinatorSession.ok) return failure(coordinatorSession.error.code);
  if (!specialistSession.ok) return failure(specialistSession.error.code);
  const combinedSession =
    combined === null
      ? null
      : await resolveActiveSessionActorAtPlacement({
          env: env,
          namespace: env.SESSION,
          placement: command.scope.placement,
          organisationId: command.organisationId,
          sessionId: combined.value.sessionId,
          now: command.receivedAt,
        });
  if (combinedSession !== null && !combinedSession.ok)
    return failure(combinedSession.error.code);
  const participantContext = (
    participant: Pick<DirectCaseIdentities, "assignmentId" | "sessionId">,
    now: number,
  ) =>
    prepareTurnContext({
      db: scope.database,
      accountAccess: scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(
        participant.sessionId,
        participant.assignmentId,
      ),
      action: "execute",
      organisationId: command.organisationId,
      caseId: base.value.caseId,
      assignmentId: participant.assignmentId,
      sessionId: participant.sessionId,
      requestAuthority: command.requestAuthority,
      policy: cappedPolicy,
      query: command.purpose,
      now,
      tailReader: caseActor.value,
      // No verified subject is in scope, so no Memory scope can match.
      memoryReader: turnMemoryReaderWithoutSubjects(),
    });
  const [coordinatorContext, specialistContext] = await Promise.all([
    participantContext(coordinator.value, command.receivedAt),
    participantContext(specialist.value, command.receivedAt),
  ]);
  if (!coordinatorContext.ok) return failure(coordinatorContext.error.code);
  if (!specialistContext.ok) return failure(specialistContext.error.code);
  const delivery = await resolveDirectCaseDelivery(
    env,
    command.organisationId,
    base.value.caseId,
    command.delivery,
    command.receivedAt,
  );
  if (!delivery.ok) return delivery;
  const result = await runDirectTwoSessionCasePath({
    env,
    pinnedAgent: command.pinnedAgent ?? null,
    caseActor: caseActor.value,
    organisationId: command.organisationId,
    caseId: base.value.caseId,
    triggerId: `trigger_${base.value.digest}`,
    triggerSource: command.triggerSource,
    content: command.content,
    ...(command.title === undefined ? {} : { title: command.title }),
    purpose: command.purpose,
    principal: command.principal,
    policy: cappedPolicy,
    workspaceRevisionReceipt: workspace.value,
    receivedAt: command.receivedAt,
    participants: [
      {
        session: coordinatorSession.value,
        requestId: command.requestId,
        sessionId: coordinator.value.sessionId,
        assignmentId: coordinator.value.assignmentId,
        role: "coordinator",
        objective: command.coordinatorObjective,
      },
      {
        session: specialistSession.value,
        requestId: command.requestId,
        sessionId: specialist.value.sessionId,
        assignmentId: specialist.value.assignmentId,
        role: "specialist",
        objective: command.specialistObjective,
      },
    ],
    delivery: delivery.value,
    turnAuthority: coordinatorContext.value.turnAuthority,
    revalidateTurnAuthority: prepareTurnAuthority.bind(null, {
      db: scope.database,
      accountAccess: scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(
        coordinator.value.sessionId,
        coordinator.value.assignmentId,
      ),
      action: "execute",
      organisationId: command.organisationId,
      requestAuthority: command.requestAuthority,
      policy: cappedPolicy,
    }),
    contexts: [
      coordinatorContext.value.context,
      specialistContext.value.context,
    ],
    ...(combined === null ||
    combinedSession === null ||
    command.combinedObjective === undefined
      ? {}
      : {
          combined: {
            participant: {
              session: combinedSession.value,
              requestId: command.requestId,
              sessionId: combined.value.sessionId,
              assignmentId: combined.value.assignmentId,
              role: "coordinator" as const,
              inputKey: "combined",
              objective: command.combinedObjective,
            },
            prepareParticipantContexts: async () => {
              const [first, second] = await Promise.all([
                participantContext(coordinator.value, Date.now()),
                participantContext(specialist.value, Date.now()),
              ]);
              if (!first.ok) return first;
              if (!second.ok) return second;
              return {
                ok: true as const,
                value: [first.value.context, second.value.context] as const,
              };
            },
            // The context is read after both participants ended, so that it
            // holds what each of them proposed.
            prepareContext: async () => {
              const prepared = await participantContext(
                combined.value,
                Date.now(),
              );
              return prepared.ok
                ? { ok: true as const, value: prepared.value.context }
                : prepared;
            },
          },
        }),
  });
  if (!result.ok)
    return result.error.kind === "budget_exhausted"
      ? { ok: false, error: result.error }
      : failure(result.error.code);
  return {
    ok: true,
    value: {
      ...result.value,
      caseId: base.value.caseId,
      sessionIds: [coordinator.value.sessionId, specialist.value.sessionId],
      assignmentIds: [
        coordinator.value.assignmentId,
        specialist.value.assignmentId,
      ],
      combinedAssignmentId:
        combined === null ? null : combined.value.assignmentId,
    },
  };
}

async function resolveDirectCaseDelivery(
  env: Env,
  organisationId: OrganisationId,
  caseId: CaseId,
  delivery: DirectCaseCommandDelivery,
  now: number,
): Promise<Result<DirectCaseDelivery, DirectCaseCommandError>> {
  switch (delivery.kind) {
    case "none":
      return { ok: true, value: { kind: "none" } };
    case "connector": {
      const connector = await resolveActiveConnectorActor({
        env: env,
        namespace: env.CONNECTOR,
        organisationId,
        connectorId: delivery.connectorId,
        now,
      });
      if (!connector.ok) return failure(connector.error.code);
      const connectorIdentity: ConnectorIdentity = {
        organisationId,
        connectorId: delivery.connectorId,
      };
      return {
        ok: true,
        value: {
          kind: "connector",
          connector: connector.value,
          connectorIdentity,
          binding: {
            bindingId: `binding_${caseId}`,
            caseId,
            connectorId: delivery.connectorId,
            address: delivery.address,
          },
        },
      };
    }
    default:
      return assertNever(delivery);
  }
}

async function loadDirectCasePolicy(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  now: number,
  requiredModelRoute: OrganisationModelRoute | null,
): Promise<Result<PinnedSessionPolicy, DirectCaseCommandError>> {
  const [workspaceModel, loaded] = await Promise.all([
    resolveOrganisationModelRouteAtScope({ env, scope, now }),
    loadOrganisationPolicyOrDefaultDeny({
      bindings: { db: scope.database, kv: env.POLICY_KV },
      organisationId,
      now,
    }),
  ]);
  if (!workspaceModel.ok) return failure(workspaceModel.error.code);
  const modelRoute =
    requiredModelRoute === null
      ? workspaceModel
      : selectOrganisationChatModel(
          workspaceModel.value,
          requiredModelRoute.model,
        );
  if (!modelRoute.ok) return failure(modelRoute.error.code);
  if (
    requiredModelRoute !== null &&
    (await digestModelRoute(modelRoute.value)) !==
      (await digestModelRoute(requiredModelRoute))
  )
    return failure("conversation_model_connection_changed");
  return {
    ok: true,
    value: {
      version: loaded.snapshot.version,
      egress: loaded.snapshot.egress,
      authz: loaded.snapshot.authz,
      conversationRisk: loaded.snapshot.conversationRisk,
      modelRoute: modelRoute.value,
    },
  };
}

/**
 * The Case, session, and assignment one stable identity always resolves to.
 *
 * Deterministic so a caller that must name the Case before creating it — an
 * automation admitting merchant memory, for one — names the same Case the
 * command will open.
 */
export async function deriveDirectCaseIdentities(
  stableIdentity: string,
): Promise<
  Result<
    {
      readonly digest: string;
      readonly caseId: CaseId;
      readonly sessionId: SessionId;
      readonly assignmentId: AssignmentId;
    },
    DirectCaseCommandError
  >
> {
  const stable = await deriveStableCaseId(stableIdentity);
  if (stable === null) return failure("direct_case_identity_invalid");
  const { digest } = stable;
  const sessionId = parseSessionId(`session_case_${digest}`);
  const assignmentId = parseAssignmentId(`assignment_case_${digest}`);
  if (!sessionId.ok || !assignmentId.ok)
    return failure("direct_case_identity_invalid");
  return {
    ok: true,
    value: {
      digest,
      caseId: stable.caseId,
      sessionId: sessionId.value,
      assignmentId: assignmentId.value,
    },
  };
}

export async function deriveConversationTurnStream(
  stableIdentity: string,
  step: number,
): Promise<
  Result<
    {
      readonly step: number;
      readonly sessionId: SessionId;
      readonly turnId: string;
    },
    DirectCaseCommandError
  >
> {
  if (!Number.isSafeInteger(step) || step < 0)
    return failure("direct_case_identity_invalid");
  const identities = await deriveDirectCaseIdentities(stableIdentity);
  if (!identities.ok) return identities;
  return {
    ok: true,
    value: {
      step,
      sessionId: identities.value.sessionId,
      turnId: `turn_trigger_${identities.value.digest}`,
    },
  };
}

function deriveParticipantIdentities(
  digest: string,
  role: "coordinator" | "specialist" | "combined",
): Result<
  {
    readonly sessionId: SessionId;
    readonly assignmentId: AssignmentId;
  },
  DirectCaseCommandError
> {
  const sessionId = parseSessionId(`session_case_${digest}_${role}`);
  const assignmentId = parseAssignmentId(`assignment_case_${digest}_${role}`);
  return sessionId.ok && assignmentId.ok
    ? {
        ok: true,
        value: { sessionId: sessionId.value, assignmentId: assignmentId.value },
      }
    : failure("direct_case_identity_invalid");
}

function failure(code: string): Result<never, DirectCaseCommandError> {
  return { ok: false, error: { kind: "operational", code } };
}

async function prepareDirectTurnAuthority(
  input: Parameters<typeof prepareTurnAuthority>[0] &
    Readonly<{
      globalDatabase: GlobalDatabase;
      sessionId: SessionId;
      turnId: string;
    }>,
): ReturnType<typeof prepareTurnAuthority> {
  const [authorized, authority] = await Promise.all([
    authorizeDirectTurnExecution(input),
    prepareTurnAuthority(input),
  ]);
  if (!authorized) return { ok: false, error: { code: "chat_access_revoked" } };
  return authority;
}

async function authorizeDirectTurnExecution(
  input: Readonly<{
    globalDatabase: GlobalDatabase;
    db: OrganisationDatabase;
    accountAccess: import("../account-platform/access").AccountPlatformAccess;
    organisationId: OrganisationId;
    requestAuthority: RequestAuthority;
    sessionId: SessionId;
    turnId: string;
  }>,
): Promise<boolean> {
  if (input.requestAuthority.kind !== "control") return true;
  return authorizeSessionTurnExecution(
    input.globalDatabase,
    input.db,
    input.organisationId,
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      requestAuthority: input.requestAuthority,
    },
    input.accountAccess,
  );
}
