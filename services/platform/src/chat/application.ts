import { type SessionId, parseRequestId, type ControlSessionId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  attachmentParts,
  surfaceObservationFromParts,
  type PendingChatInput,
} from "./timeline";
import { pendingInputSurfaceContext } from "./input-parts";
import {
  authorizeConversation,
  conversationCaseIdentity,
} from "./conversation-access";
import type { ConversationId } from "@purin-labs/control-api";
import {
  projectSnapshotFromParts,
  bindConversationProjectSnapshot,
} from "./project-context-binding";
import {
  browserContextFromParts,
  removePendingChatInput,
  conversationTimeline,
  normalizeConversationTimeline,
  type Conversation,
} from "./conversation";
import type { Env } from "@purin-labs/kernel/env";
import type { CaseActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  deriveDirectCaseIdentities,
  type ConversationCaseActor,
} from "../actors/case-direct-processing";
import {
  resolveActiveCaseActorAtScope,
  resolveActiveSessionActorAtPlacement,
  resolveActiveSessionActorAtScope,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConversationExecution } from "./execution";
import {
  resolveControlSessionById,
  readActiveOrganisationMembership,
  roleMayConfigure,
} from "@purin-labs/tenancy/data/control-plane";
import {
  resolveOrganisationModelRouteAtScope,
  type OrganisationModelRoute,
} from "@purin-labs/agent/models/route";
import {
  readConversation,
  readConversationForExecution,
  saveConversation,
  type ConversationScope,
} from "./store";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  admitTurn,
  pendingInputText,
  timelineEventIsCancellation,
} from "./turn/admission";
import { failedConversation, settleConversationFailure } from "./turn/failure";
import {
  conversationUsesInferenceSource,
  selectStoredConversationModel,
} from "./turn/model";
import { conversationStreamIdentity, runConversation } from "./turn/run";
import {
  MODEL_ROUTE_UNAVAILABLE_MESSAGE,
  conversationTransition,
  conversationWorkAtRest,
  failConversationWork,
} from "./conversation-machine";
import { nextTimelineSequence } from "./turn/timeline";


export type ConversationExecutionFailure =
  | { readonly kind: "authority_invalid" }
  | { readonly kind: "turn_pending" }
  | { readonly kind: "conflict" };

export type RunningConversation = Conversation & {
  readonly work: Variant<Conversation["work"], "running">;
};

function isRunningConversation(
  conversation: Conversation,
): conversation is RunningConversation {
  return conversation.work.kind === "running";
}

export type AdmittedConversationExecution = {
  readonly placement: OrganisationExecutionScope;
  readonly controlSessionId: ControlSessionId;
  readonly env: Env;
  readonly scope: ConversationScope;
  readonly conversation: Conversation;
  readonly revision: number;
  readonly model: OrganisationModelRoute;
};

export type CancellingConversationExecution = Omit<
  AdmittedConversationExecution,
  "model"
>;

type ActorConversationExecution = AdmittedConversationExecution & {
  readonly actorIdentity: string;
  readonly caseActor: ConversationCaseActor;
};

export async function scheduleConversationExecution(
  env: Env,
  input: {
    readonly placement: OrganisationExecutionScope;
    readonly scope: ConversationScope;
    readonly controlSessionId: ControlSessionId;
    readonly conversation: Pick<Conversation, "id" | "work">;
  },
): Promise<void> {
  if (input.placement.organisationId !== input.scope.organisationId)
    throw new Error("organisation_placement_conflict");
  const [active, access] = await Promise.all([
    input.placement.isActive(),
    authorizeConversation(
      input.placement.database,
      input.scope,
      input.conversation.id,
    ),
  ]);
  if (!active) throw new Error("organisation_placement_conflict");
  if (
    access === null ||
    (access.access.kind !== "private" && access.role === "viewer") ||
    (access.execution.kind === "active" &&
      access.execution.userId !== input.scope.userId)
  )
    return;
  const scheduledAt = Date.now();
  const identity = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(
      input.placement.database,
      input.scope,
      input.conversation.id,
    ),
  );
  if (!identity.ok) throw new Error(identity.error.code);
  const identityReadyAt = Date.now();
  let actor: CaseActorStub;
  let sessionPreparation: Promise<void> = Promise.resolve();
  switch (input.conversation.work.kind) {
    case "running":
    case "cancelling": {
      sessionPreparation = prepareScheduledConversationSession(
        env,
        input.placement,
        input.conversation.id,
        input.conversation.work.stream.sessionId,
      );
      const resolvedCase = await resolveActiveCaseActorAtScope({
        scope: input.placement,
        namespace: env.CASE,
        caseId: identity.value.caseId,
        now: Date.now(),
      });
      if (!resolvedCase.ok) throw new Error(resolvedCase.error.code);
      actor = resolvedCase.value;
      break;
    }
    case "ready":
    case "failed":
    case "awaiting_permission": {
      const resolved = await resolveActiveCaseActorAtScope({
        scope: input.placement,
        namespace: env.CASE,
        caseId: identity.value.caseId,
        now: Date.now(),
      });
      if (!resolved.ok) throw new Error(resolved.error.code);
      actor = resolved.value;
      break;
    }
    default:
      return assertNever(input.conversation.work);
  }
  const actorReadyAt = Date.now();
  await actor.scheduleConversation({
    scope: input.scope,
    controlSessionId: input.controlSessionId,
    conversationId: input.conversation.id,
  });
  console.log(
    JSON.stringify({
      event: "chat.execution_scheduled",
      organisation_id: input.scope.organisationId,
      conversation_id: input.conversation.id,
      started_at: scheduledAt,
      duration_ms: Date.now() - scheduledAt,
      identity_ms: identityReadyAt - scheduledAt,
      actor_resolution_ms: actorReadyAt - identityReadyAt,
      scheduling_rpc_ms: Date.now() - actorReadyAt,
    }),
  );
  await sessionPreparation;
}

async function prepareScheduledConversationSession(
  env: Env,
  placement: OrganisationExecutionScope,
  conversationId: ConversationId,
  sessionId: SessionId,
): Promise<void> {
  // Session preparation must not delay the Case wake or prevent its recovery.
  try {
    const prepared = await resolveActiveSessionActorAtScope({
      scope: placement,
      namespace: env.SESSION,
      sessionId,
      now: Date.now(),
    });
    if (prepared.ok) return;
  } catch {
    // The Case retains responsibility for retrying Session admission.
  }
  console.warn(
    JSON.stringify({
      event: "chat.session_preparation_pending",
      organisation_id: placement.organisationId,
      conversation_id: conversationId,
    }),
  );
}

export async function authorizeConversationExecution(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  controlSessionId: ControlSessionId,
  conversationId: ConversationId,
) {
  if (placement.organisationId !== scope.organisationId)
    return {
      ok: false as const,
      error: { kind: "authority_invalid" as const },
    };
  const [session, active, access, membership] = await Promise.all([
    resolveControlSessionById({
      db: env.DB,
      controlSessionId,
      now: Date.now(),
    }),
    placement.isActive(),
    authorizeConversation(placement.database, scope, conversationId),
    readActiveOrganisationMembership(
      placement.database,
      scope.organisationId,
      scope.userId,
    ),
  ]);
  if (!session.ok || session.value.userId !== scope.userId || !active)
    return {
      ok: false as const,
      error: { kind: "authority_invalid" as const },
    };
  if (
    access === null ||
    (access.access.kind !== "private" && access.role === "viewer") ||
    (access.execution.kind === "active" &&
      access.execution.userId !== scope.userId)
  )
    return {
      ok: false as const,
      error: { kind: "authority_invalid" as const },
    };
  return membership !== null &&
    (roleMayConfigure(membership.role) ||
      (access.access.kind === "workspace_canvas" &&
        membership.role === "operator"))
    ? { ok: true as const, membership, access }
    : {
        ok: false as const,
        error: { kind: "authority_invalid" as const },
      };
}

export async function resumeConversationExecution(
  env: Env,
  placement: OrganisationExecutionScope,
  input: ConversationExecution,
  caseActor: ConversationCaseActor,
): Promise<"settled" | "pending"> {
  if (
    placement.organisationId !== input.scope.organisationId ||
    !(await placement.isActive())
  )
    return "pending";
  let stored = await readConversationForExecution(placement, input);
  if (stored?.conversation.work.kind === "cancelling") {
    const cancelled = await settleCancellingConversation({
      env,
      placement,
      scope: input.scope,
      controlSessionId: input.controlSessionId,
      conversation: stored.conversation,
      revision: stored.revision,
    });
    if (cancelled === null) return "pending";
    stored = await readConversation(
      placement.database,
      input.scope,
      input.conversationId,
    );
  }
  if (stored === null || conversationWorkAtRest(stored.conversation))
    return "settled";
  const workspaceModel = await resolveOrganisationModelRouteAtScope({
    env,
    scope: placement,
    now: Date.now(),
  });
  const model = workspaceModel.ok
    ? selectStoredConversationModel(workspaceModel.value, stored.conversation)
    : workspaceModel;
  if (
    !model.ok ||
    !workspaceModel.ok ||
    !conversationUsesInferenceSource(stored.conversation, workspaceModel.value)
  ) {
    // The person sees the failure now, with a retry, instead of a queue
    // that waits for good (Refactor 15, refactor 9).
    const work = stored.conversation.work;
    const failed =
      work.kind === "running" || work.kind === "cancelling"
        ? await settleConversationFailure({
            env,
            placement,
            scope: input.scope,
            conversationId: input.conversationId,
            requestId: work.requestId,
            lease: work.lease,
            message: MODEL_ROUTE_UNAVAILABLE_MESSAGE,
          })
        : await blockQueuedConversation(placement, input, stored);
    return failed === null ? "pending" : "settled";
  }
  const execution: ActorConversationExecution = {
    actorIdentity: stored.actorIdentity,
    caseActor,
    env,
    placement,
    scope: input.scope,
    controlSessionId: input.controlSessionId,
    conversation: stored.conversation,
    revision: stored.revision,
    model: model.value,
  };
  switch (stored.conversation.work.kind) {
    case "running":
      await finishAdmittedConversation(execution);
      break;
    case "cancelling":
      await finishSteeringConversation(execution);
      break;
    case "ready":
      await drainQueuedConversation(execution, stored.conversation);
      break;
    case "failed":
    case "awaiting_permission":
      // At rest, so the read above returned.
      break;
    default:
      assertNever(stored.conversation.work);
  }
  const latest = await readConversationForExecution(placement, input);
  return latest === null || conversationWorkAtRest(latest.conversation)
    ? "settled"
    : "pending";
}

/**
 * The model route is unavailable while a message waits in the queue. The
 * message becomes the conversation's turn, failed with the reason, so the
 * person sees it at once and retries it once the route works. The other
 * queued messages wait behind it. Null when the conversation moved.
 */
async function blockQueuedConversation(
  placement: OrganisationExecutionScope,
  input: ConversationExecution,
  stored: NonNullable<Awaited<ReturnType<typeof readConversationForExecution>>>,
): Promise<Conversation | null> {
  const pending = nextPendingInput(stored.conversation.pendingInputs);
  if (
    pending === undefined ||
    !conversationTransition(stored.conversation.work, "block", {
      now: Date.now(),
      modelRouteAvailable: false,
    }).allowed
  )
    return null;
  const admitted = await admitTurn(
    {
      ...stored,
      conversation: removePendingChatInput(
        stored.conversation,
        pending.inputId,
      ),
    },
    {
      kind: "message",
      conversationId: stored.conversation.id,
      requestId: pending.requestId,
      model: stored.conversation.modelRoute.model,
      text: pendingInputText(pending),
      browserContext: browserContextFromParts(pending.parts),
      surfaceContext: pendingInputSurfaceContext(pending),
      attachments: attachmentParts(pending.parts),
      ...(pending.effort === undefined ? {} : { effort: pending.effort }),
      ...surfaceObservationFromParts(pending.parts),
    },
    stored.conversation.modelRoute,
    input.scope,
  );
  if (!admitted.ok || admitted.kind !== "admitted") return null;
  const blocked = failConversationWork(
    { ...admitted.conversation, work: { kind: "ready" } },
    pending.requestId,
    MODEL_ROUTE_UNAVAILABLE_MESSAGE,
    Date.now(),
  );
  const saved = await saveConversation(
    placement,
    input.scope.userId,
    blocked,
    stored.revision,
  );
  return saved.kind === "saved" ? blocked : null;
}

async function finishAdmittedConversation(
  input: ActorConversationExecution,
): Promise<void> {
  if (!isRunningConversation(input.conversation)) return;
  const result = await runConversation(
    input.controlSessionId,
    input.env,
    input.placement,
    input.scope,
    input.conversation,
    input.revision,
    input.model,
    input.caseActor,
    input.actorIdentity,
  );
  if (result.ok) await drainQueuedConversation(input, result.conversation);
  if (!result.ok)
    console.error("portal_chat_background_failed", result.error.kind);
}

async function finishSteeringConversation(
  input: ActorConversationExecution,
): Promise<{
  readonly conversation: Conversation;
  readonly revision: number;
} | null> {
  const settled = await settleCancellingConversation(input);
  if (settled === null) return null;
  await drainQueuedConversation(input, settled.conversation);
  return settled;
}

export async function settleCancellingConversation(
  input: CancellingConversationExecution,
): Promise<{
  readonly conversation: Conversation;
  readonly revision: number;
} | null> {
  const cancelling = input.conversation.work;
  if (cancelling.kind !== "cancelling") return null;
  const requestId = parseRequestId(cancelling.requestId);
  if (!requestId.ok) return null;
  const actor = await resolveActiveSessionActorAtPlacement({
    placement: input.placement.placement,
    env: input.env,
    namespace: input.env.SESSION,
    organisationId: input.scope.organisationId,
    sessionId: cancelling.stream.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) return null;
  const interrupted = await actor.value.interruptCanonicalEmbeddedHarnessTurn({
    requestId: requestId.value,
    organisationId: input.scope.organisationId,
    sessionId: cancelling.stream.sessionId,
    interruptedAt: Date.now(),
  });
  if (!interrupted.ok) return null;
  const latest = await readConversation(
    input.placement.database,
    input.scope,
    input.conversation.id,
  );
  if (latest === null) return null;
  if (
    latest.conversation.work.kind !== "cancelling" ||
    latest.conversation.work.cancellationId !== cancelling.cancellationId ||
    latest.conversation.work.requestId !== cancelling.requestId
  ) {
    const replay = conversationTimeline(latest.conversation).some(
      timelineEventIsCancellation.bind(
        null,
        cancelling.cancellationId,
        cancelling.requestId,
      ),
    );
    return replay
      ? { conversation: latest.conversation, revision: latest.revision }
      : null;
  }
  const timeline = conversationTimeline(latest.conversation);
  const cancelled = normalizeConversationTimeline({
    ...latest.conversation,
    work: { kind: "ready" },
    timeline: [
      ...timeline,
      {
        kind: "run_cancelled",
        eventId: cancelling.cancellationId,
        sequence: nextTimelineSequence(timeline),
        requestId: cancelling.requestId,
        createdAt: Date.now(),
        text: "Response stopped.",
      },
    ],
  });
  if (
    !(
      (
        await saveConversation(
          input.placement,
          input.scope.userId,
          cancelled,
          latest.revision,
        )
      ).kind === "saved"
    )
  )
    return null;
  return { conversation: cancelled, revision: latest.revision + 1 };
}

async function drainQueuedConversation(
  input: ActorConversationExecution,
  completed: Conversation,
): Promise<void> {
  let conversationId = completed.id;
  for (;;) {
    const stored = await readConversation(
      input.placement.database,
      input.scope,
      conversationId,
    );
    if (stored === null || stored.conversation.work.kind !== "ready") return;
    const pending = nextPendingInput(stored.conversation.pendingInputs);
    if (pending === undefined) return;
    const withoutPending = removePendingChatInput(
      stored.conversation,
      pending.inputId,
    );
    const unboundAdmission = await admitTurn(
      { ...stored, conversation: withoutPending },
      {
        kind: "message",
        conversationId: withoutPending.id,
        requestId: pending.requestId,
        model: input.model.model,
        text: pendingInputText(pending),
        browserContext: browserContextFromParts(pending.parts),
        surfaceContext: pendingInputSurfaceContext(pending),
        attachments: attachmentParts(pending.parts),
        ...(pending.effort === undefined ? {} : { effort: pending.effort }),
        ...surfaceObservationFromParts(pending.parts),
      },
      input.model,
      input.scope,
    );
    const snapshot = projectSnapshotFromParts(pending.parts);
    const admitted =
      unboundAdmission.ok && snapshot !== null
        ? {
            ...unboundAdmission,
            conversation: bindConversationProjectSnapshot(
              unboundAdmission.conversation,
              pending.requestId,
              snapshot,
            ),
          }
        : unboundAdmission;
    if (
      !admitted.ok ||
      admitted.kind !== "admitted" ||
      !isRunningConversation(admitted.conversation)
    )
      return;
    const saved = await saveConversation(
      input.placement,
      input.scope.userId,
      admitted.conversation,
      stored.revision,
    );
    if (saved.kind === "capacity") {
      const blocked = failedConversation(
        stored.conversation,
        pending.requestId,
        "This chat has reached its storage limit. Start a new chat to continue. Your queued message is preserved.",
      );
      await saveConversation(
        input.placement,
        input.scope.userId,
        blocked,
        stored.revision,
      );
      return;
    }
    if (saved.kind === "conflict") return;
    const result = await runConversation(
      input.controlSessionId,
      input.env,
      input.placement,
      input.scope,
      admitted.conversation,
      stored.revision + 1,
      input.model,
      input.caseActor,
      stored.actorIdentity,
    );
    if (!result.ok) return;
    conversationId = result.conversation.id;
  }
}

function nextPendingInput(
  pending: readonly PendingChatInput[],
): PendingChatInput | undefined {
  return pending.find(pendingInputIsSteering) ?? pending[0];
}

function pendingInputIsSteering(input: PendingChatInput): boolean {
  return input.mode === "steer";
}

export async function nextRunningWork(
  actorIdentity: string,
  work: Variant<Conversation["work"], "running">,
  step: number,
): Promise<Variant<Conversation["work"], "running">> {
  const stream = await conversationStreamIdentity(
    actorIdentity,
    work.lease,
    step,
  );
  if (!stream.ok) throw new Error(stream.error);
  return {
    kind: "running",
    requestId: work.requestId,
    lease: work.lease,
    expiresAt: Date.now() + 15 * 60_000,
    stream: stream.value,
  };
}
