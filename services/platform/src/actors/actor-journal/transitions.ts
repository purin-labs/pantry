import type { AgentSessionLifecycle, SessionCommand } from "@seams/contracts";
import { validateCanonicalSessionAdvance } from "../../actor-wasm";
import { readCanonicalSessionProjection } from "../agent-session-canonical";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import type {
  CancellationResolvedSessionCommit,
  CancellationResolvedTransition,
  CancellationStartedSessionCommit,
  CheckpointCommittedSessionCommit,
  CheckpointingStartedSessionCommit,
  ExecutionRequestedSessionCommit,
  ExecutionSettledSessionCommit,
  QuarantinedSessionCommit,
  TerminatedSessionCommit,
} from "../actor-journal";

export function isValidExecutionSettledTransition(
  sql: SqlStorage,
  input: ExecutionSettledSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "processing") return false;
  const command: SessionCommand = {
    kind: "accept_execution_receipt",
    runtimeLease: input.harnessLease.runtimeLease,
    turnLeaseGeneration: input.harnessLease.turn.turnLeaseGeneration,
    receipt: input.event.body.receipt,
  };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  if (!validation.ok) return false;
  const receiptBody = input.event.body.receipt.receipt;
  if (receiptBody.kind !== "inline") return false;
  return (
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence &&
    input.harnessLease.session.sessionId ===
      input.state.state.identity.sessionId &&
    input.harnessLease.turn.turnId === receiptBody.value.turn.turnId &&
    input.harnessLease.turn.inputId === receiptBody.value.turn.inputId &&
    input.harnessLease.turn.turnLeaseGeneration ===
      receiptBody.value.turn.turnLeaseGeneration
  );
}

export function isValidExecutionRequestedTransition(
  sql: SqlStorage,
  input: ExecutionRequestedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "processing") return false;
  const requestBody = input.event.body.request.request;
  if (requestBody.kind !== "inline") return false;
  const command: SessionCommand = {
    kind: "request_execution",
    runtimeLease: input.harnessLease.runtimeLease,
    turnLeaseGeneration: input.harnessLease.turn.turnLeaseGeneration,
    request: input.event.body.request,
  };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  if (!validation.ok) return false;
  const request = requestBody.value;
  return (
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence &&
    input.harnessLease.session.sessionId ===
      input.state.state.identity.sessionId &&
    input.harnessLease.turn.turnId === request.turn.turnId &&
    input.harnessLease.turn.inputId === request.turn.inputId &&
    input.harnessLease.turn.turnLeaseGeneration ===
      request.turn.turnLeaseGeneration &&
    input.reserve.organisationId === input.event.organisationId &&
    input.reserve.sessionId === input.event.actorId &&
    input.reserve.turnId === request.turn.turnId &&
    input.reserve.executionId === request.executionId &&
    input.reserve.admissionDigest === request.admissionDigest &&
    input.reserve.runtimeGeneration ===
      input.harnessLease.runtimeLease.generation &&
    input.event.body.request.effectId ===
      `execution-${input.reserve.executionId}` &&
    input.event.body.request.idempotencyKey === input.reserve.idempotencyKey
  );
}

export function isValidQuarantinedTransition(
  sql: SqlStorage,
  input: QuarantinedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "processing") return false;
  const validation = validateCanonicalSessionAdvance({
    current,
    command: { kind: "quarantine", reason: "effect_indeterminate" },
    transition: input.event.body,
    state: input.state,
  });
  return (
    validation.ok &&
    input.event.body.state.reason === "effect_indeterminate" &&
    input.event.body.state.recovery.kind === "terminate_only" &&
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence &&
    input.indeterminateReason.length > 0
  );
}

/**
 * The end of a quarantine that only termination may leave: the Session ends
 * as `failed`, as the interrupted turn that quarantined it did.
 */
export function isValidTerminatedTransition(
  sql: SqlStorage,
  input: TerminatedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (
    current === null ||
    current.kind !== "quarantined" ||
    current.state.recovery.kind !== "terminate_only"
  )
    return false;
  const validation = validateCanonicalSessionAdvance({
    current,
    command: {
      kind: "terminate",
      reason: input.state.state.reason,
      terminalAt: input.state.state.terminalAt,
    },
    transition: input.event.body,
    state: input.state,
  });
  return (
    validation.ok &&
    input.state.state.reason === "failed" &&
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence
  );
}

export function isValidCheckpointingStartedTransition(
  sql: SqlStorage,
  input: CheckpointingStartedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "processing") return false;
  const turn = current.state.activeTurn.state.identity;
  const command: SessionCommand = {
    kind: "begin_checkpoint",
    runtimeLease: input.harnessLease.runtimeLease,
    turnLeaseGeneration: input.harnessLease.turn.turnLeaseGeneration,
    outcome: input.state.state.outcome,
    workspaceRevisionReceipt: input.state.state.workspaceRevisionReceipt,
  };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  if (!validation.ok) return false;
  return (
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence &&
    input.harnessLease.session.sessionId ===
      input.state.state.identity.sessionId &&
    input.harnessLease.turn.turnId === turn.turnId &&
    input.harnessLease.turn.inputId === turn.inputId
  );
}

export function isValidCheckpointCommittedTransition(
  sql: SqlStorage,
  input: CheckpointCommittedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "checkpointing") return false;
  const resumePoint = input.state.state.resumePoint;
  if (resumePoint.kind !== "checkpoint") return false;
  const command: SessionCommand = {
    kind: "commit_checkpoint",
    checkpoint: resumePoint.checkpoint,
  };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  if (!validation.ok) return false;
  const harnessCheckpoint = input.harnessCheckpoint;
  return (
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence &&
    harnessCheckpoint.session.sessionId ===
      input.state.state.identity.sessionId &&
    harnessCheckpoint.runtimeLease.generation ===
      resumePoint.checkpoint.runtimeGeneration &&
    harnessCheckpoint.runtimeRevision ===
      resumePoint.checkpoint.runtimeRevision &&
    harnessCheckpoint.policyVersion === resumePoint.checkpoint.policyVersion &&
    harnessCheckpoint.workspaceRevision ===
      resumePoint.checkpoint.workspaceRevisionReceipt.revision &&
    harnessCheckpoint.lastActorEventSequence ===
      current.state.contract.lastEventSequence - 1
  );
}

export function isValidCancellationStartedTransition(
  sql: SqlStorage,
  input: CancellationStartedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (
    current === null ||
    (current.kind !== "processing" &&
      current.kind !== "checkpointing" &&
      current.kind !== "recovering")
  ) {
    return false;
  }
  const plan = input.event.body.state.plan;
  const command: SessionCommand =
    plan.kind === "turn"
      ? { kind: "cancel", target: { kind: "turn", turnId: plan.turnId } }
      : { kind: "cancel", target: { kind: "session", reason: plan.reason } };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  const envelopeMatches =
    validation.ok &&
    JSON.stringify(input.event.body.state) ===
      JSON.stringify(input.state.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence;
  if (!envelopeMatches) return false;
  if (plan.lease.kind === "none")
    return current.kind === "recovering" && input.harnessLease === undefined;
  if (input.harnessLease === undefined) return false;
  return (
    input.harnessLease.session.sessionId ===
      input.state.state.identity.sessionId &&
    input.harnessLease.runtimeLease.generation ===
      plan.lease.runtimeLease.generation &&
    input.harnessLease.runtimeLease.leaseId ===
      plan.lease.runtimeLease.leaseId &&
    input.harnessLease.turn.turnLeaseGeneration ===
      plan.lease.turnLeaseGeneration
  );
}

export function isValidCancellationResolvedTransition(
  current: Variant<AgentSessionLifecycle, "cancelling">,
  input: CancellationResolvedSessionCommit,
): boolean {
  const resolution = input.event.body.resolution;
  const command: SessionCommand = cancellationResolutionCommand(resolution);
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition: input.event.body,
    state: input.state,
  });
  const resolvedState = cancellationResolutionState(resolution);
  return (
    validation.ok &&
    JSON.stringify(resolvedState) === JSON.stringify(input.state) &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence
  );
}

export function cancellationResolutionCommand(
  resolution: CancellationResolvedTransition["resolution"],
): SessionCommand {
  switch (resolution.kind) {
    case "sleeping":
      return {
        kind: "resolve_cancellation",
        resolution: { kind: "return_to_sleeping" },
      };
    case "checkpointing":
      return {
        kind: "resolve_cancellation",
        resolution: {
          kind: "begin_checkpointing",
          workspaceRevisionReceipt: resolution.state.workspaceRevisionReceipt,
        },
      };
    case "terminal":
      return {
        kind: "resolve_cancellation",
        resolution: {
          kind: "terminate",
          terminalAt: resolution.state.terminalAt,
        },
      };
    default:
      return assertNever(resolution);
  }
}

export function cancellationResolutionState(
  resolution: CancellationResolvedTransition["resolution"],
): CancellationResolvedSessionCommit["state"] {
  switch (resolution.kind) {
    case "sleeping":
      return { kind: "sleeping", state: resolution.state };
    case "checkpointing":
      return { kind: "checkpointing", state: resolution.state };
    case "terminal":
      return { kind: "terminal", state: resolution.state };
    default:
      return assertNever(resolution);
  }
}
