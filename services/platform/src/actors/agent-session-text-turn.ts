import type {
  AgentSessionLifecycle,
  EventEnvelope,
  HarnessCheckpointRecord,
  HarnessTurnLease,
  SessionTransition,
  Timestamp,
  WorkspaceRevisionReceipt,
} from "@seams/contracts";

import { validateCanonicalSessionAdvance } from "../actor-wasm";
import type { Result } from "../result";
import type {
  CheckpointCommittedSessionCommit,
  CheckpointingStartedSessionCommit,
  CancellationResolvedSessionCommit,
  ActiveLeaseCancellationStartedSessionCommit,
} from "./actor-journal";
import type { Variant } from "@seams/type-utils";
import { sha256Hex } from "@seams/std";

export type CanonicalTextTurnTransitionError = {
  readonly code: "canonical_text_turn_transition_invalid";
  readonly reason: string;
};

export type CanonicalTextTurnCompletionIdentity = {
  readonly completionId: string;
  readonly acceptedAt: Timestamp;
};

type CanonicalTextTurnCancellationIdentity = {
  readonly cancellationId: string;
  readonly correlationId: string;
  readonly acceptedAt: Timestamp;
};

export function buildTextTurnCancellationStartedCommit(input: {
  readonly current: Variant<AgentSessionLifecycle, "processing">;
  readonly harnessLease: HarnessTurnLease;
  readonly cancellation: CanonicalTextTurnCancellationIdentity;
}): Result<
  ActiveLeaseCancellationStartedSessionCommit,
  CanonicalTextTurnTransitionError
> {
  if (!validCancellationIdentity(input.cancellation)) {
    return transitionError("cancellation_identity_invalid");
  }
  if (
    !leaseMatchesState(
      input.current,
      input.harnessLease,
      input.cancellation.acceptedAt,
    )
  ) {
    return transitionError("harness_lease_mismatch");
  }
  const turn = input.current.state.activeTurn.state.identity;
  const state: ActiveLeaseCancellationStartedSessionCommit["state"] = {
    kind: "cancelling",
    state: {
      identity: input.current.state.identity,
      contract: nextContract(input.current.state.contract),
      plan: {
        kind: "turn",
        turnId: turn.turnId,
        inputId: turn.inputId,
        resumePoint: input.current.state.resumePoint,
        lease: {
          kind: "active",
          runtimeLease: input.current.state.runtimeLease,
          turnLeaseGeneration: turn.turnLeaseGeneration,
        },
      },
    },
  };
  const transition: Variant<SessionTransition, "cancellation_started"> = {
    kind: "cancellation_started",
    state: state.state,
  };
  const commandId = `${input.cancellation.cancellationId}:start`;
  const commit: ActiveLeaseCancellationStartedSessionCommit = {
    source: "surface_actor",
    commandId,
    event: cancellationEnvelope({
      state,
      transition,
      commandId,
      eventId: `${input.cancellation.cancellationId}:started`,
      idempotencyKey: `${input.cancellation.cancellationId}:started`,
      correlationId: input.cancellation.correlationId,
      acceptedAt: input.cancellation.acceptedAt,
    }),
    state,
    harnessLease: input.harnessLease,
  };
  const checked = validateCanonicalSessionAdvance({
    current: input.current,
    command: { kind: "cancel", target: { kind: "turn", turnId: turn.turnId } },
    transition,
    state,
  });
  return checked.ok
    ? { ok: true, value: commit }
    : transitionError(checked.error.code);
}

export function buildTextTurnCancellationResolvedCommit(input: {
  readonly current: Variant<AgentSessionLifecycle, "cancelling">;
  readonly cancellation: CanonicalTextTurnCancellationIdentity;
}): Result<
  CancellationResolvedSessionCommit,
  CanonicalTextTurnTransitionError
> {
  if (!validCancellationIdentity(input.cancellation)) {
    return transitionError("cancellation_identity_invalid");
  }
  if (input.current.state.plan.kind !== "turn") {
    return transitionError("cancellation_plan_invalid");
  }
  const state: CancellationResolvedSessionCommit["state"] = {
    kind: "sleeping",
    state: {
      identity: input.current.state.identity,
      contract: nextContract(input.current.state.contract),
      resumePoint: input.current.state.plan.resumePoint,
    },
  };
  const transition: Variant<SessionTransition, "cancellation_resolved"> = {
    kind: "cancellation_resolved",
    resolution: { kind: "sleeping", state: state.state },
  };
  const commandId = `${input.cancellation.cancellationId}:resolve`;
  const commit: CancellationResolvedSessionCommit = {
    source: "operator",
    commandId,
    event: cancellationEnvelope({
      state,
      transition,
      commandId,
      eventId: `${input.cancellation.cancellationId}:resolved`,
      idempotencyKey: `${input.cancellation.cancellationId}:resolved`,
      correlationId: input.cancellation.correlationId,
      acceptedAt: input.cancellation.acceptedAt,
    }),
    state,
  };
  const checked = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "resolve_cancellation",
      resolution: { kind: "return_to_sleeping" },
    },
    transition,
    state,
  });
  return checked.ok
    ? { ok: true, value: commit }
    : transitionError(checked.error.code);
}

export function buildTextTurnCheckpointingCommit(input: {
  readonly current: Variant<AgentSessionLifecycle, "processing">;
  readonly harnessLease: HarnessTurnLease;
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  readonly completion: CanonicalTextTurnCompletionIdentity;
}): Result<
  CheckpointingStartedSessionCommit,
  CanonicalTextTurnTransitionError
> {
  const validation = validateCompletionIdentity(input.completion);
  if (!validation.ok) return validation;
  const turn = input.current.state.activeTurn.state.identity;
  if (
    !leaseMatchesProcessingState(
      input.current,
      input.harnessLease,
      input.completion,
    )
  ) {
    return transitionError("harness_lease_mismatch");
  }
  const state: CheckpointingStartedSessionCommit["state"] = {
    kind: "checkpointing",
    state: {
      identity: input.current.state.identity,
      contract: nextContract(input.current.state.contract),
      runtimeLease: input.current.state.runtimeLease,
      turnId: turn.turnId,
      inputId: turn.inputId,
      turnLeaseGeneration: turn.turnLeaseGeneration,
      outcome: "completed",
      resumePoint: input.current.state.resumePoint,
      workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    },
  };
  const transition: Variant<SessionTransition, "checkpointing_started"> = {
    kind: "checkpointing_started",
    state: state.state,
  };
  const commandId = `${input.completion.completionId}:begin-checkpoint`;
  const commit: CheckpointingStartedSessionCommit = {
    source: "harness",
    commandId,
    event: transitionEnvelope({
      state,
      transition,
      commandId,
      eventId: `${input.completion.completionId}:checkpointing-started`,
      idempotencyKey: `${input.completion.completionId}:checkpointing-started`,
      correlationId: input.workspaceRevisionReceipt.correlationId,
      acceptedAt: input.completion.acceptedAt,
    }),
    state,
    harnessLease: input.harnessLease,
  };
  const checked = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "begin_checkpoint",
      runtimeLease: input.harnessLease.runtimeLease,
      turnLeaseGeneration: input.harnessLease.turn.turnLeaseGeneration,
      outcome: "completed",
      workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    },
    transition,
    state,
  });
  return checked.ok
    ? { ok: true, value: commit }
    : transitionError(checked.error.code);
}

function cancellationEnvelope<T extends SessionTransition>(input: {
  readonly state: AgentSessionLifecycle;
  readonly transition: T;
  readonly commandId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly acceptedAt: Timestamp;
}): EventEnvelope<T> {
  return {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: input.eventId,
    organisationId: input.state.state.identity.organisationId,
    actorId: input.state.state.identity.sessionId,
    streamId: input.state.state.identity.streamId,
    sequence: input.state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: input.acceptedAt },
    acceptedAt: input.acceptedAt,
    correlationId: input.correlationId,
    causation: { kind: "command", commandId: input.commandId },
    idempotencyKey: input.idempotencyKey,
    runtimeRevision: input.state.state.contract.runtimeRevision,
    principal: { kind: "system", componentId: "surface_actor" },
    sensitivity: "organisation_private",
    retention: "session",
    body: input.transition,
  };
}

export async function buildTextTurnCheckpointCommittedCommit(input: {
  readonly current: Variant<AgentSessionLifecycle, "checkpointing">;
  readonly harnessLease?: never;
  readonly harnessCheckpoint: HarnessCheckpointRecord;
  readonly completion: CanonicalTextTurnCompletionIdentity;
}): Promise<
  Result<CheckpointCommittedSessionCommit, CanonicalTextTurnTransitionError>
> {
  const validation = validateCompletionIdentity(input.completion);
  if (!validation.ok) return validation;
  if (!checkpointMatchesCheckpointingState(input)) {
    return transitionError("harness_checkpoint_mismatch");
  }
  const checkpointIdDigest = await sha256Hex(
    JSON.stringify(input.harnessCheckpoint),
  );
  const state: CheckpointCommittedSessionCommit["state"] = {
    kind: "sleeping",
    state: {
      identity: input.current.state.identity,
      contract: nextContract(input.current.state.contract),
      resumePoint: {
        kind: "checkpoint",
        checkpoint: {
          checkpointId: `checkpoint_${checkpointIdDigest}`,
          stateDigest: input.harnessCheckpoint.blob.sha256,
          lastEventSequence: input.current.state.contract.lastEventSequence,
          runtimeRevision: input.current.state.contract.runtimeRevision,
          runtimeGeneration: input.current.state.runtimeLease.generation,
          policyVersion: input.current.state.contract.policyVersion,
          budgetRevision: input.harnessCheckpoint.budgetRevision,
          budgetUsage: input.harnessCheckpoint.budgetUsage,
          usageCursor: input.harnessCheckpoint.usageCursor,
          budgetAccountDigest: input.harnessCheckpoint.budgetAccountDigest,
          workspaceRevisionReceipt:
            input.current.state.workspaceRevisionReceipt,
        },
      },
    },
  };
  const transition: Variant<SessionTransition, "checkpoint_committed"> = {
    kind: "checkpoint_committed",
    state: state.state,
  };
  const commandId = `${input.completion.completionId}:commit-checkpoint`;
  const commit: CheckpointCommittedSessionCommit = {
    source: "harness",
    commandId,
    event: transitionEnvelope({
      state,
      transition,
      commandId,
      eventId: `${input.completion.completionId}:checkpoint-committed`,
      idempotencyKey: `${input.completion.completionId}:checkpoint-committed`,
      correlationId: input.current.state.workspaceRevisionReceipt.correlationId,
      acceptedAt: input.completion.acceptedAt,
    }),
    state,
    harnessCheckpoint: input.harnessCheckpoint,
  };
  const checked = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "commit_checkpoint",
      checkpoint: state.state.resumePoint.checkpoint,
    },
    transition,
    state,
  });
  return checked.ok
    ? { ok: true, value: commit }
    : transitionError(checked.error.code);
}

function transitionEnvelope<T extends SessionTransition>(input: {
  readonly state: AgentSessionLifecycle;
  readonly transition: T;
  readonly commandId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly acceptedAt: Timestamp;
}): EventEnvelope<T> {
  return {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: input.eventId,
    organisationId: input.state.state.identity.organisationId,
    actorId: input.state.state.identity.sessionId,
    streamId: input.state.state.identity.streamId,
    sequence: input.state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: input.acceptedAt },
    acceptedAt: input.acceptedAt,
    correlationId: input.correlationId,
    causation: { kind: "command", commandId: input.commandId },
    idempotencyKey: input.idempotencyKey,
    runtimeRevision: input.state.state.contract.runtimeRevision,
    principal: { kind: "system", componentId: "embedded_harness" },
    sensitivity: "organisation_private",
    retention: "session",
    body: input.transition,
  };
}

function nextContract(
  contract: AgentSessionLifecycle["state"]["contract"],
): AgentSessionLifecycle["state"]["contract"] {
  return {
    policyVersion: contract.policyVersion,
    budgetRevision: contract.budgetRevision,
    runtimeRevision: contract.runtimeRevision,
    modelRoute: contract.modelRoute,
    lastEventSequence: contract.lastEventSequence + 1,
  };
}

function validateCompletionIdentity(
  completion: CanonicalTextTurnCompletionIdentity,
): Result<true, CanonicalTextTurnTransitionError> {
  return completion.completionId.length > 0 &&
    Number.isSafeInteger(completion.acceptedAt) &&
    completion.acceptedAt >= 0
    ? { ok: true, value: true }
    : transitionError("completion_identity_invalid");
}

function validCancellationIdentity(
  cancellation: CanonicalTextTurnCancellationIdentity,
): boolean {
  return (
    cancellation.cancellationId.length > 0 &&
    cancellation.correlationId.length > 0 &&
    Number.isSafeInteger(cancellation.acceptedAt) &&
    cancellation.acceptedAt >= 0
  );
}

export function checkpointMatchesCheckpointingState(input: {
  readonly current: Variant<AgentSessionLifecycle, "checkpointing">;
  readonly harnessCheckpoint: HarnessCheckpointRecord;
}): boolean {
  const state = input.current.state;
  const checkpoint = input.harnessCheckpoint;
  return (
    JSON.stringify(checkpoint.session) === JSON.stringify(state.identity) &&
    JSON.stringify(checkpoint.runtimeLease) ===
      JSON.stringify(state.runtimeLease) &&
    checkpoint.runtimeRevision === state.contract.runtimeRevision &&
    checkpoint.policyVersion === state.contract.policyVersion &&
    checkpoint.budgetRevision === state.contract.budgetRevision &&
    checkpoint.turn.budgetRevision === checkpoint.budgetRevision &&
    checkpoint.lastActorEventSequence + 1 ===
      state.contract.lastEventSequence &&
    checkpoint.workspaceRevision === state.workspaceRevisionReceipt.revision &&
    checkpoint.turn.turnId === state.turnId &&
    checkpoint.turn.inputId === state.inputId &&
    checkpoint.turn.turnLeaseGeneration === state.turnLeaseGeneration &&
    checkpoint.cursor.turn.turnId === checkpoint.turn.turnId
  );
}

function leaseMatchesProcessingState(
  state: Variant<AgentSessionLifecycle, "processing">,
  lease: HarnessTurnLease,
  completion: CanonicalTextTurnCompletionIdentity,
): boolean {
  return leaseMatchesState(state, lease, completion.acceptedAt);
}

function leaseMatchesState(
  state: Variant<AgentSessionLifecycle, "processing">,
  lease: HarnessTurnLease,
  acceptedAt: Timestamp,
): boolean {
  return (
    JSON.stringify(lease.session) === JSON.stringify(state.state.identity) &&
    JSON.stringify(lease.turn) ===
      JSON.stringify(state.state.activeTurn.state.identity) &&
    JSON.stringify(lease.runtimeLease) ===
      JSON.stringify(state.state.runtimeLease) &&
    lease.runtimeRevision === state.state.contract.runtimeRevision &&
    lease.issuedAt <= acceptedAt &&
    acceptedAt < lease.expiresAt
  );
}

function transitionError(
  reason: string,
): Result<never, CanonicalTextTurnTransitionError> {
  return {
    ok: false,
    error: { code: "canonical_text_turn_transition_invalid", reason },
  };
}
