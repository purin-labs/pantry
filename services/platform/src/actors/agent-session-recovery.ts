import type {
  AgentSessionLifecycle,
  EventEnvelope,
  HarnessTaskContinuation,
  HarnessTurnLease,
  RecoveringSession,
  RequestAuthority,
  RuntimeLease,
  SessionContract,
  SessionRecoveryAction,
  SessionTransition,
} from "@seams/contracts";
import type { Variant } from "@seams/type-utils";
import { validateCanonicalSessionAdvance } from "../actor-wasm";
import type { Result } from "../result";
import type {
  ExecutionRecoveryStartedSessionCommit,
  ExecutionRecoveryUpdatedSessionCommit,
  ExecutionResumedSessionCommit,
  FencedCancellationStartedSessionCommit,
} from "./actor-journal";

type RecoveryEvent = {
  readonly operationId: string;
  readonly acceptedAt: number;
};
type RecoveryBuildError = {
  readonly code: "session_recovery_invalid";
  readonly reason: string;
};

type ResumableSessionRecovery = Omit<RecoveringSession, "action"> & {
  action: Variant<SessionRecoveryAction, "resume_task">;
};

export function buildSessionExecutionRecovery(input: {
  readonly current: Variant<AgentSessionLifecycle, "processing">;
  readonly fencedHarnessLease: HarnessTurnLease;
  readonly continuation: HarnessTaskContinuation;
  readonly action: SessionRecoveryAction;
  readonly event: RecoveryEvent;
}): Result<ExecutionRecoveryStartedSessionCommit, RecoveryBuildError> {
  const previous = input.current.state;
  const state: Variant<AgentSessionLifecycle, "recovering"> = {
    kind: "recovering",
    state: {
      identity: previous.identity,
      contract: nextRecoveryContract(previous.contract),
      resumePoint: previous.resumePoint,
      fencedRuntime: previous.runtimeLease,
      activeTurn: previous.activeTurn,
      continuation: input.continuation,
      action: input.action,
    },
  };
  const body: Variant<SessionTransition, "execution_recovery_started"> = {
    kind: "execution_recovery_started",
    state: state.state,
  };
  const valid = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "begin_execution_recovery",
      continuation: input.continuation,
      action: input.action,
    },
    transition: body,
    state,
  });
  if (!valid.ok) return recoveryError(valid.error.code);
  return {
    ok: true,
    value: {
      source: "scheduler",
      commandId: input.event.operationId,
      event: recoveryEnvelope(state, body, input.event, "scheduler"),
      state,
      fencedHarnessLease: input.fencedHarnessLease,
    },
  };
}

export function buildSessionRecoveryAction(input: {
  readonly current: Variant<AgentSessionLifecycle, "recovering">;
  readonly action: SessionRecoveryAction;
  readonly event: RecoveryEvent;
}): Result<ExecutionRecoveryUpdatedSessionCommit, RecoveryBuildError> {
  const previous = input.current.state;
  const state: Variant<AgentSessionLifecycle, "recovering"> = {
    kind: "recovering",
    state: {
      identity: previous.identity,
      contract: nextRecoveryContract(previous.contract),
      resumePoint: previous.resumePoint,
      fencedRuntime: previous.fencedRuntime,
      activeTurn: previous.activeTurn,
      continuation: previous.continuation,
      action: input.action,
    },
  };
  const body: Variant<SessionTransition, "execution_recovery_updated"> = {
    kind: "execution_recovery_updated",
    state: state.state,
  };
  const valid = validateCanonicalSessionAdvance({
    current: input.current,
    command: { kind: "update_execution_recovery", action: input.action },
    transition: body,
    state,
  });
  if (!valid.ok) return recoveryError(valid.error.code);
  return {
    ok: true,
    value: {
      source: "scheduler",
      commandId: input.event.operationId,
      event: recoveryEnvelope(state, body, input.event, "scheduler"),
      state,
    },
  };
}

export function buildSessionExecutionResume(input: {
  readonly current: { kind: "recovering"; state: ResumableSessionRecovery };
  readonly runtimeLease: RuntimeLease;
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartitionDigest: string;
  readonly harnessLeaseId: string;
  readonly expiresAt: number;
  readonly event: RecoveryEvent;
}): Result<ExecutionResumedSessionCommit, RecoveryBuildError> {
  const previous = input.current.state;
  const state: Variant<AgentSessionLifecycle, "processing"> = {
    kind: "processing",
    state: {
      identity: previous.identity,
      contract: nextRecoveryContract(previous.contract),
      resumePoint: previous.resumePoint,
      runtimeLease: input.runtimeLease,
      activeTurn: previous.activeTurn,
    },
  };
  const body: Variant<SessionTransition, "execution_resumed"> = {
    kind: "execution_resumed",
    state: state.state,
  };
  const valid = validateCanonicalSessionAdvance({
    current: input.current,
    command: { kind: "resume_execution", runtimeLease: input.runtimeLease },
    transition: body,
    state,
  });
  if (!valid.ok) return recoveryError(valid.error.code);
  const harnessLease: HarnessTurnLease = {
    leaseId: input.harnessLeaseId,
    session: previous.identity,
    turn: previous.activeTurn.state.identity,
    runtimeLease: input.runtimeLease,
    runtimeRevision: previous.contract.runtimeRevision,
    requestAuthority: input.requestAuthority,
    authorityPartitionDigest: input.authorityPartitionDigest,
    issuedAt: input.event.acceptedAt,
    expiresAt: input.expiresAt,
  };
  return {
    ok: true,
    value: {
      source: "capacity_governor",
      commandId: input.event.operationId,
      event: recoveryEnvelope(state, body, input.event, "capacity_governor"),
      state,
      harnessLease,
    },
  };
}

export function buildRecoveringSessionCancellation(input: {
  readonly current: Variant<AgentSessionLifecycle, "recovering">;
  readonly event: RecoveryEvent;
}): Result<FencedCancellationStartedSessionCommit, RecoveryBuildError> {
  const previous = input.current.state;
  const turn = previous.activeTurn.state.identity;
  const state: FencedCancellationStartedSessionCommit["state"] = {
    kind: "cancelling",
    state: {
      identity: previous.identity,
      contract: nextRecoveryContract(previous.contract),
      plan: {
        kind: "turn",
        turnId: turn.turnId,
        inputId: turn.inputId,
        resumePoint: previous.resumePoint,
        lease: { kind: "none" },
      },
    },
  };
  const body: Variant<SessionTransition, "cancellation_started"> = {
    kind: "cancellation_started",
    state: state.state,
  };
  const valid = validateCanonicalSessionAdvance({
    current: input.current,
    command: { kind: "cancel", target: { kind: "turn", turnId: turn.turnId } },
    transition: body,
    state,
  });
  if (!valid.ok) return recoveryError(valid.error.code);
  return {
    ok: true,
    value: {
      source: "surface_actor",
      commandId: input.event.operationId,
      event: recoveryEnvelope(state, body, input.event, "surface_actor"),
      state,
    },
  };
}

function nextRecoveryContract(contract: SessionContract): SessionContract {
  return {
    policyVersion: contract.policyVersion,
    budgetRevision: contract.budgetRevision,
    runtimeRevision: contract.runtimeRevision,
    modelRoute: contract.modelRoute,
    lastEventSequence: contract.lastEventSequence + 1,
  };
}

function recoveryEnvelope<T extends SessionTransition>(
  state: AgentSessionLifecycle,
  body: T,
  event: RecoveryEvent,
  source: "scheduler" | "capacity_governor" | "surface_actor",
): EventEnvelope<T> {
  return {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: event.operationId,
    organisationId: state.state.identity.organisationId,
    actorId: state.state.identity.sessionId,
    streamId: state.state.identity.streamId,
    sequence: state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: event.acceptedAt },
    acceptedAt: event.acceptedAt,
    correlationId: event.operationId,
    causation: { kind: "command", commandId: event.operationId },
    idempotencyKey: event.operationId,
    runtimeRevision: state.state.contract.runtimeRevision,
    principal: { kind: "system", componentId: source },
    sensitivity: "organisation_private",
    retention: "audit_required",
    body,
  };
}

function recoveryError(reason: string): Result<never, RecoveryBuildError> {
  return { ok: false, error: { code: "session_recovery_invalid", reason } };
}
