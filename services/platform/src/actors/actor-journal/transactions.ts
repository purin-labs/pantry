import { readAcceptedCheckpointFinalization } from "../agent-session-finalization";
import {
  recordPantryTurnCancellationInTransaction,
  recordPantryTurnCompletionInTransaction,
  recordPantrySessionCancellationInTransaction,
} from "../../account-platform/execution-billing";
import type {
  AcceptedInputRef,
  AgentSessionLifecycle,
  CaseAssignment,
  EventEnvelope,
  SessionCommand,
  SessionTransition,
} from "@seams/contracts";
import { validateCanonicalSessionAdvance } from "../../actor-wasm";
import { parseStoredAuthorityPartition } from "../../authorization/access-grants/turn-authority";
import type { Result } from "../../result";
import {
  readCanonicalSessionProjection,
  readImportedCanonicalSession,
  writeCanonicalSessionProjection,
} from "../agent-session-canonical";
import {
  createSessionBudgetAccount,
  markRunBudgetIndeterminate,
  readSessionBudgetAccount,
  reserveRunBudget,
} from "../agent-session-budget";
import {
  closeCommittedHarnessTurnInTransaction,
  commitHarnessCheckpoint,
  retainHarnessCheckpointUploadInTransaction,
  type HarnessCheckpointCommit,
  fenceHarnessTurnLeaseInTransaction,
  issueHarnessTurnLeaseInTransaction,
  preflightHarnessTurnLeaseInTransaction,
} from "../agent-session-harness-authority";
import type { PreparedHarnessCheckpoint } from "../agent-session-harness-checkpoint";
import {
  beginSessionTurnStream,
  completeSessionTurnStream,
  failSessionTurnStream,
  readRunningSessionTurn,
  type SessionTurnStreamError,
} from "../agent-session-turn-stream";
import { appendSessionInformationFlowInTransaction } from "../agent-session-information-flow";
import {
  materializeContextBundle,
  type ContextBundle,
  type ModelContextBundle,
} from "../../context/assembly";
import type { Variant, VariantBy } from "@seams/type-utils";
import {
  assertNever,
  canonicalJson,
  hasExactKeys,
  isNonEmptyString,
  isRecord,
} from "@seams/std";
import {
  type AcceptedActorCommand,
  type AcceptedSessionInputCommit,
  type ActorTransactionStorage,
  type ActorTransitionCommitError,
  type ActorTransitionCommitResult,
  type CancellationResolvedSessionCommit,
  type CancellationStartedSessionCommit,
  type CheckpointCommittedSessionCommit,
  type CheckpointingStartedSessionCommit,
  type CompletedSessionTurnCommit,
  type ExecutionRecoveryStartedSessionCommit,
  type ExecutionRecoveryUpdatedSessionCommit,
  type ExecutionRequestedSessionCommit,
  type ExecutionResumedSessionCommit,
  type ExecutionSettledSessionCommit,
  type InitializedCaseSessionCommit,
  type InitializedSessionCommit,
  type QuarantinedSessionCommit,
  type RuntimeActivatedSessionCommit,
  type SessionQuarantineCommit,
  type SessionTurnContext,
  type SessionTurnContextLookup,
  type SessionTurnContextRow,
  type SessionTurnMemoryRendering,
  type StartedSessionCommit,
  type StartedSessionCommitError,
  type StartedSessionCommitResult,
  type StoredContextBundle,
  type TerminatedSessionCommit,
  digestStoredContextBundle,
} from "../actor-journal";
import {
  CompositeCommitAbort,
  JournalTransitionAbort,
  MAX_EVENT_BYTES,
  StartedSessionBudgetAbort,
} from "./aborts";
import {
  normalizedStoredTurnContext,
  parseContextBundle,
  parseStoredTurnContext,
  readDuplicateAcceptance,
  readNextSequence,
  serializeContextBundle,
  writeExecutionRequest,
  writeInboxAcceptance,
  writeJournalEvent,
  writeRuntimeActivatedJournalEvent,
  writeSessionJournalEvent,
} from "./parsers";
import {
  isValidCancellationResolvedTransition,
  isValidCancellationStartedTransition,
  isValidCheckpointCommittedTransition,
  isValidCheckpointingStartedTransition,
  isValidExecutionRequestedTransition,
  isValidExecutionSettledTransition,
  isValidQuarantinedTransition,
  isValidTerminatedTransition,
} from "./transitions";

// A complete accepted checkpoint can finalize after its execution lease is fenced.
// Unfinished calls retain receipt evidence and require reconciliation.
export function recoverInterruptedSessionInTransaction(
  sql: SqlStorage,
  now: number,
): void {
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM session_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return;
  const session = readImportedCanonicalSession(sql, row.organisation_id);
  if (!session.ok) throw new Error(session.error.code);
  const current = session.value.lifecycle;
  if (current.kind === "checkpointing") {
    const finalization = readAcceptedCheckpointFinalization(sql);
    if (finalization.ok && finalization.value.kind === "pending") {
      sql.exec(
        "DELETE FROM session_harness_lease WHERE session_id = ?",
        current.state.identity.sessionId,
      );
      return;
    }
  }
  switch (current.kind) {
    case "sleeping":
    case "recovering":
    case "quarantined":
    case "terminal":
      return;
    case "activating":
    case "processing":
    case "checkpointing":
    case "cancelling":
      break;
    default:
      assertNever(current);
  }
  const state: SessionQuarantineCommit["state"] = {
    kind: "quarantined",
    state: {
      identity: current.state.identity,
      contract: {
        policyVersion: current.state.contract.policyVersion,
        budgetRevision: current.state.contract.budgetRevision,
        runtimeRevision: current.state.contract.runtimeRevision,
        modelRoute: current.state.contract.modelRoute,
        lastEventSequence: current.state.contract.lastEventSequence + 1,
      },
      reason: "effect_indeterminate",
      recovery: { kind: "terminate_only" },
    },
  };
  const commandId = `interrupted_${state.state.identity.sessionId}_${state.state.contract.lastEventSequence}`;
  const input: SessionQuarantineCommit = {
    source: "harness",
    commandId,
    state,
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: commandId,
      organisationId: state.state.identity.organisationId,
      actorId: state.state.identity.sessionId,
      streamId: state.state.identity.streamId,
      sequence: state.state.contract.lastEventSequence,
      sourceTime: { kind: "satyr", issuedAt: now },
      acceptedAt: now,
      correlationId: commandId,
      causation: { kind: "command", commandId },
      idempotencyKey: commandId,
      runtimeRevision: state.state.contract.runtimeRevision,
      principal: { kind: "system", componentId: "agent_session_actor" },
      sensitivity: "organisation_private",
      retention: "audit_required",
      body: { kind: "session_quarantined", state: state.state },
    },
  };
  const valid = validateCanonicalSessionAdvance({
    current,
    command: { kind: "quarantine", reason: "effect_indeterminate" },
    transition: input.event.body,
    state,
  });
  if (!valid.ok) throw new Error(valid.error.code);
  if (input.event.sequence !== readNextSequence(sql, input.event.streamId)) {
    throw new Error("journal_sequence_gap");
  }
  const encoded = encodeJournalEvent(input.event);
  if (!encoded.ok) throw new Error(encoded.error.code);
  const budget = readSessionBudgetAccount(sql, state.state.identity);
  if (!budget.ok) throw new Error(budget.error.code);
  if (
    budget.value.kind === "open" &&
    budget.value.reservation.kind === "active"
  ) {
    const reservation = budget.value.reservation;
    const marked = markRunBudgetIndeterminate(sql, {
      organisationId: state.state.identity.organisationId,
      sessionId: state.state.identity.sessionId,
      runId: reservation.reservation.runId,
      reservationId: reservation.reservation.reservationId,
      runtimeGeneration: reservation.reservation.runtimeGeneration,
      turnLeaseGeneration: reservation.reservation.turnLeaseGeneration,
      budgetRevision: reservation.reservation.budgetRevision,
      operationId: commandId,
      reason:
        reservation.acceptedUsage.capabilityCalls > 0
          ? "provider_effect_indeterminate"
          : "model_receipt_missing",
      now,
    });
    if (!marked.ok) throw new Error(marked.error.code);
  }
  const running = readRunningSessionTurn(sql);
  if (!running.ok) throw new Error(running.error.code);
  if (running.value !== null) {
    const failed = failSessionTurnStream(
      sql,
      running.value.turnId,
      "session_interrupted",
      now,
    );
    if (!failed.ok) throw new Error(failed.error.code);
  }
  sql.exec(
    "DELETE FROM session_harness_lease WHERE session_id = ?",
    state.state.identity.sessionId,
  );
  const committed = writeCanonicalTransition(sql, input, encoded.value);
  if (!committed.ok) throw new Error(committed.error.code);
}

/**
 * Ends a Session that an older release quarantined when a process loss
 * interrupted its turn: the reducer allows only termination from that
 * quarantine, and the Session ends as `failed`, as Refactor 15 ends the turn
 * itself. The caller checks first that the Session holds no other work. As
 * each Session termination does, it cancels the open billing of its turns.
 */
export function terminateQuarantinedSessionInTransaction(
  sql: SqlStorage,
  current: Variant<AgentSessionLifecycle, "quarantined">,
  now: number,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const state: TerminatedSessionCommit["state"] = {
    kind: "terminal",
    state: {
      identity: current.state.identity,
      contract: {
        policyVersion: current.state.contract.policyVersion,
        budgetRevision: current.state.contract.budgetRevision,
        runtimeRevision: current.state.contract.runtimeRevision,
        modelRoute: current.state.contract.modelRoute,
        lastEventSequence: current.state.contract.lastEventSequence + 1,
      },
      reason: "failed",
      terminalAt: now,
    },
  };
  const commandId = `quarantine_ended_${state.state.identity.sessionId}_${state.state.contract.lastEventSequence}`;
  const input: TerminatedSessionCommit = {
    source: "harness",
    commandId,
    state,
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: commandId,
      organisationId: state.state.identity.organisationId,
      actorId: state.state.identity.sessionId,
      streamId: state.state.identity.streamId,
      sequence: state.state.contract.lastEventSequence,
      sourceTime: { kind: "satyr", issuedAt: now },
      acceptedAt: now,
      correlationId: commandId,
      causation: { kind: "command", commandId },
      idempotencyKey: commandId,
      runtimeRevision: state.state.contract.runtimeRevision,
      principal: { kind: "system", componentId: "agent_session_actor" },
      sensitivity: "organisation_private",
      retention: "audit_required",
      body: { kind: "session_terminated", state: state.state },
    },
  };
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidTerminatedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  sql.exec(
    "DELETE FROM session_harness_lease WHERE session_id = ?",
    state.state.identity.sessionId,
  );
  const committed = writeCanonicalTransition(sql, input, envelope.value);
  if (!committed.ok) return committed;
  const billing = recordPantrySessionCancellationInTransaction(sql, {
    sessionId: state.state.identity.sessionId,
    sourceRecordId: input.event.eventId,
    sequence: input.event.sequence,
    occurredAt: now,
  });
  if (!billing.ok) throw new JournalTransitionAbort(billing.error);
  return committed;
}

export function commitCheckpointingStartedSession(
  storage: ActorTransactionStorage,
  input: CheckpointingStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitCheckpointingStartedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitPreparedSessionCheckpoint(
  storage: ActorTransactionStorage,
  checkpoint: PreparedHarnessCheckpoint,
  transition: CheckpointingStartedSessionCommit,
): Result<HarnessCheckpointCommit, ActorTransitionCommitError> {
  try {
    return storage.transactionSync(
      commitPreparedSessionCheckpointTransaction.bind(
        null,
        storage,
        checkpoint,
        transition,
      ),
    );
  } catch (error) {
    if (error instanceof JournalTransitionAbort)
      return { ok: false, error: error.commitError };
    throw error;
  }
}

function commitPreparedSessionCheckpointTransaction(
  storage: ActorTransactionStorage,
  prepared: PreparedHarnessCheckpoint,
  transition: CheckpointingStartedSessionCommit,
): Result<HarnessCheckpointCommit, ActorTransitionCommitError> {
  const checkpoint = prepared.commit;
  if (checkpoint.leaseId !== transition.harnessLease.leaseId)
    return { ok: false, error: { code: "invalid_transition" } };
  const committed = commitHarnessCheckpoint(storage, checkpoint);
  if (!committed.ok)
    return {
      ok: false,
      error: {
        code: "harness_checkpoint_invalid",
        reason: committed.error.code,
      },
    };
  if (committed.value.kind === "committed") {
    const retained = retainHarnessCheckpointUploadInTransaction(
      storage.sql,
      checkpoint.checkpoint,
      prepared.payload,
    );
    if (!retained.ok)
      throw new JournalTransitionAbort({
        code: "harness_checkpoint_invalid",
        reason: retained.error.code,
      });
  }
  const started = commitCheckpointingStartedSessionTransaction(
    storage.sql,
    transition,
  );
  if (!started.ok) throw new JournalTransitionAbort(started.error);
  const fenced = fenceHarnessTurnLeaseInTransaction(
    storage.sql,
    transition.harnessLease,
  );
  if (!fenced.ok)
    throw new JournalTransitionAbort({
      code: "harness_lease_invalid",
      reason: fenced.error.code,
    });
  return committed;
}

export function commitCancellationStartedSession(
  storage: ActorTransactionStorage,
  input: CancellationStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitCancellationStartedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitCancellationResolvedSession(
  storage: ActorTransactionStorage,
  input: CancellationResolvedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  try {
    return storage.transactionSync(
      commitCancellationResolvedSessionTransaction.bind(
        null,
        storage.sql,
        input,
      ),
    );
  } catch (error) {
    if (error instanceof JournalTransitionAbort)
      return { ok: false, error: error.commitError };
    throw error;
  }
}

export function commitStartedSessionTransaction(
  sql: SqlStorage,
  input: StartedSessionCommit,
): Result<StartedSessionCommitResult, StartedSessionCommitError> {
  if (
    input.acceptedInput.state.state.identity.organisationId !==
      input.stream.organisationId ||
    input.activatedRuntime.harnessLease.turn.turnId !== input.stream.turnId ||
    !sessionTurnContextMatchesCommit(input) ||
    !sessionInformationFlowMatchesCommit(input)
  ) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const acceptedInput = commitAcceptedSessionInputTransaction(
    sql,
    input.acceptedInput,
  );
  if (!acceptedInput.ok) return acceptedInput;
  const activatedRuntime = commitRuntimeActivatedSessionTransaction(
    sql,
    input.activatedRuntime,
  );
  if (!activatedRuntime.ok)
    throw new CompositeCommitAbort(activatedRuntime.error);
  const stream = beginSessionTurnStream(sql, input.stream);
  if (!stream.ok) throw new CompositeCommitAbort(stream.error);
  const attachmentsPayload = JSON.stringify(input.attachments);
  const existingAttachments =
    sql
      .exec<
        Record<string, SqlStorageValue> & {
          organisation_id: string;
          session_id: string;
          attachments_json: string;
        }
      >(
        "SELECT organisation_id, session_id, attachments_json FROM session_turn_attachment WHERE turn_id = ?",
        input.stream.turnId,
      )
      .toArray()[0] ?? null;
  if (existingAttachments !== null) {
    if (
      existingAttachments.organisation_id !== input.stream.organisationId ||
      existingAttachments.session_id !==
        input.acceptedInput.state.state.identity.sessionId ||
      existingAttachments.attachments_json !== attachmentsPayload
    ) {
      throw new CompositeCommitAbort({ code: "idempotency_conflict" });
    }
  } else {
    sql.exec(
      "INSERT INTO session_turn_attachment (turn_id, organisation_id, session_id, attachments_json, links_json) VALUES (?, ?, ?, ?, ?)",
      input.stream.turnId,
      input.stream.organisationId,
      input.acceptedInput.state.state.identity.sessionId,
      attachmentsPayload,
      JSON.stringify(input.links ?? []),
    );
  }
  persistSessionTurnContext(sql, input);
  const informationFlow = appendSessionInformationFlowInTransaction(
    sql,
    input.informationFlow,
  );
  if (!informationFlow.ok) {
    throw new CompositeCommitAbort(
      mapInformationFlowCommitError(informationFlow.error),
    );
  }
  const lease = input.activatedRuntime.harnessLease;
  const runId = `run_${lease.turn.turnId}_${lease.runtimeLease.generation}_${lease.turn.turnLeaseGeneration}`;
  const reservation = reserveRunBudget(sql, {
    organisationId: lease.session.organisationId,
    sessionId: lease.session.sessionId,
    operationId: `budget_reserve_${runId}`,
    now: Date.now(),
    runId,
    reservationId: `reservation_${lease.session.sessionId}_${runId}_${lease.runtimeLease.generation}_${lease.turn.turnLeaseGeneration}_${lease.turn.budgetRevision}`,
    runtimeGeneration: lease.runtimeLease.generation,
    turnLeaseGeneration: lease.turn.turnLeaseGeneration,
    budgetRevision: lease.turn.budgetRevision,
    turnId: lease.turn.turnId,
  });
  if (!reservation.ok) throw new StartedSessionBudgetAbort(reservation.error);
  return {
    ok: true,
    value: {
      acceptedInput: acceptedInput.value,
      activatedRuntime: activatedRuntime.value,
      stream: stream.value,
      reservation: reservation.value,
      flowBinding: input.informationFlow.binding,
    },
  };
}

function sessionInformationFlowMatchesCommit(
  input: StartedSessionCommit,
): boolean {
  const lease = input.activatedRuntime.harnessLease;
  const informationFlow = input.informationFlow;
  return (
    informationFlow.organisationId === lease.session.organisationId &&
    informationFlow.sessionId === lease.session.sessionId &&
    informationFlow.turnId === lease.turn.turnId &&
    informationFlow.authorityPartitionDigest ===
      lease.authorityPartitionDigest &&
    informationFlow.context.organisationId === lease.session.organisationId &&
    informationFlow.context.sessionId === lease.session.sessionId &&
    informationFlow.context.authorityPartitionDigest ===
      lease.authorityPartitionDigest
  );
}

function mapInformationFlowCommitError(
  error: import("../agent-session-information-flow").SessionInformationFlowError,
): ActorTransitionCommitError {
  switch (error.code) {
    case "session_information_flow_conflict":
    case "session_information_flow_authority_mismatch":
      return { code: "idempotency_conflict" };
    case "session_information_flow_invalid":
    case "session_information_flow_stale":
    case "session_information_flow_observation_missing":
      return { code: "invalid_persisted_state" };
    default:
      return assertNever(error);
  }
}

function sessionTurnContextMatchesCommit(input: StartedSessionCommit): boolean {
  const acceptedInput = input.acceptedInput.event.body.input;
  const lease = input.activatedRuntime.harnessLease;
  const context = input.context;
  return (
    /^[0-9a-f]{64}$/u.test(context.bundleDigest) &&
    context.bundleDigest === acceptedInput.contextBundleDigest &&
    context.bundle.organisationId === lease.session.organisationId &&
    context.bundle.sessionId === lease.session.sessionId &&
    acceptedInputCaseIdentityMatchesBundle(acceptedInput, context.bundle) &&
    modelContextMatchesBundle(context.modelContext, context.bundle)
  );
}

function acceptedInputCaseIdentityMatchesBundle(
  acceptedInput: AcceptedInputRef,
  bundle: StoredContextBundle,
): boolean {
  return (
    acceptedInput.caseId === bundle.caseId &&
    acceptedInput.assignmentId === bundle.assignmentId
  );
}

function modelContextMatchesBundle(
  modelContext: ModelContextBundle,
  bundle: StoredContextBundle,
): boolean {
  return (
    JSON.stringify(modelContext) ===
    JSON.stringify(materializeContextBundle(bundle))
  );
}

function persistSessionTurnContext(
  sql: SqlStorage,
  input: StartedSessionCommit,
): void {
  const turnId = input.stream.turnId;
  const organisationId = input.stream.organisationId;
  const sessionId = input.acceptedInput.state.state.identity.sessionId;
  const bundleJson = JSON.stringify({
    bundle: serializeContextBundle(input.context.bundle),
    projectContext: input.context.projectContext,
  });
  const existing =
    sql
      .exec<SessionTurnContextRow>(
        `SELECT organisation_id, session_id, bundle_digest, bundle_json
     FROM session_turn_context
     WHERE turn_id = ?`,
        turnId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    if (
      existing.organisation_id !== organisationId ||
      existing.session_id !== sessionId ||
      existing.bundle_digest !== input.context.bundleDigest ||
      normalizedStoredTurnContext(existing.bundle_json) !== bundleJson
    ) {
      throw new CompositeCommitAbort({ code: "idempotency_conflict" });
    }
    return;
  }
  sql.exec(
    `INSERT INTO session_turn_context
      (turn_id, organisation_id, session_id, bundle_digest, bundle_json)
     VALUES (?, ?, ?, ?, ?)`,
    turnId,
    organisationId,
    sessionId,
    input.context.bundleDigest,
    bundleJson,
  );
}

/**
 * Records one attempt at a transient turn: its accepted bundle and the Memory
 * its prompt carries. It is written before the model is asked, so the record
 * never trails what the model received.
 *
 * Each attempt has its own record, named by the turn and its bundle digest,
 * and a record is never changed. A retry assembles a new bundle and so adds a
 * record beside the earlier one. Recording the same attempt again returns the
 * record it already has.
 */
export function recordTransientTurnContext(
  sql: SqlStorage,
  input: Readonly<{
    turnId: string;
    organisationId: string;
    sessionId: string;
    context: Pick<SessionTurnContext, "bundle" | "bundleDigest">;
    memoryRendering: SessionTurnMemoryRendering;
  }>,
): Result<"recorded" | "reused", { readonly code: "invalid_persisted_state" }> {
  const attemptId = transientTurnAttemptId(
    input.turnId,
    input.context.bundleDigest,
  );
  const bundleJson = JSON.stringify({
    bundle: serializeContextBundle(input.context.bundle),
    projectContext: null,
    memoryRendering: input.memoryRendering,
  });
  const existing = sql
    .exec<SessionTurnContextRow>(
      `SELECT organisation_id, session_id, bundle_digest, bundle_json
       FROM session_turn_context WHERE turn_id = ?`,
      attemptId,
    )
    .toArray()[0];
  if (existing !== undefined)
    return existing.organisation_id === input.organisationId &&
      existing.session_id === input.sessionId &&
      existing.bundle_digest === input.context.bundleDigest &&
      existing.bundle_json === bundleJson
      ? { ok: true, value: "reused" }
      : { ok: false, error: { code: "invalid_persisted_state" } };
  sql.exec(
    `INSERT INTO session_turn_context
      (turn_id, organisation_id, session_id, bundle_digest, bundle_json)
     VALUES (?, ?, ?, ?, ?)`,
    attemptId,
    input.organisationId,
    input.sessionId,
    input.context.bundleDigest,
    bundleJson,
  );
  return { ok: true, value: "recorded" };
}

/** A transient turn's attempts share this prefix; each adds its bundle digest. */
function transientTurnAttemptPrefix(turnId: string): string {
  return `${turnId}#`;
}

function transientTurnAttemptId(turnId: string, bundleDigest: string): string {
  return `${transientTurnAttemptPrefix(turnId)}${bundleDigest}`;
}

/**
 * What the model of one attempt was given of accepted Memory. It is the
 * accepted bundle's outcome, unless the prompt's byte budget then withheld a
 * revision the bundle admitted. In that case it is `limited` by
 * `prompt_bytes`, with the revisions the prompt did carry.
 */
type SessionTurnShownMemory =
  | NonNullable<ContextBundle["memory"]>
  | Readonly<{
      kind: "limited";
      revisions: SessionTurnMemoryRendering["revisions"];
      reason: "prompt_bytes";
    }>;

/** What one attempt at a turn recorded about Memory before its model call. */
type SessionTurnMemoryRecord = Readonly<{
  bundleDigest: string;
  assembledAt: number;
  outcome: ContextBundle["memory"];
  rendering: SessionTurnMemoryRendering;
  shown: SessionTurnShownMemory;
}>;

/**
 * Every attempt's Memory record for one transient turn, oldest first: the
 * outcome its accepted bundle holds and the revisions its prompt carried.
 */
export async function readSessionTurnMemoryRecords(
  sql: SqlStorage,
  lookup: SessionTurnContextLookup,
): Promise<
  Result<
    readonly SessionTurnMemoryRecord[],
    { readonly code: "invalid_persisted_state" }
  >
> {
  const prefix = transientTurnAttemptPrefix(lookup.turnId);
  const rows = sql
    .exec<SessionTurnContextRow>(
      `SELECT organisation_id, session_id, bundle_digest, bundle_json
       FROM session_turn_context WHERE substr(turn_id, 1, ?) = ?`,
      prefix.length,
      prefix,
    )
    .toArray();
  const records: SessionTurnMemoryRecord[] = [];
  for (const row of rows) {
    if (
      row.organisation_id !== lookup.organisationId ||
      row.session_id !== lookup.sessionId
    )
      return { ok: false, error: { code: "invalid_persisted_state" } };
    let raw: unknown;
    try {
      raw = JSON.parse(row.bundle_json);
    } catch {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const stored = parseStoredTurnContext(raw);
    const bundle =
      stored === null ? null : await parseContextBundle(stored.bundle);
    if (
      stored === null ||
      stored.memoryRendering === null ||
      bundle === null ||
      bundle.memory === undefined ||
      (await digestStoredContextBundle(bundle)) !== row.bundle_digest
    )
      return { ok: false, error: { code: "invalid_persisted_state" } };
    records.push({
      bundleDigest: row.bundle_digest,
      assembledAt: bundle.assembledAt,
      outcome: bundle.memory,
      rendering: stored.memoryRendering,
      shown: stored.memoryRendering.omittedForBytes
        ? {
            kind: "limited",
            revisions: stored.memoryRendering.revisions,
            reason: "prompt_bytes",
          }
        : bundle.memory,
    });
  }
  return {
    ok: true,
    value: records.sort((left, right) => left.assembledAt - right.assembledAt),
  };
}

export function commitCompletedSessionTurnTransaction(
  sql: SqlStorage,
  input: CompletedSessionTurnCommit,
): Result<
  ActorTransitionCommitResult,
  ActorTransitionCommitError | SessionTurnStreamError
> {
  const accepted = input.checkpoint.harnessCheckpoint;
  if (
    input.completedAt !== accepted.blob.createdAt ||
    input.lastSequence !== accepted.cursor.lastSequence - 1 ||
    input.checkpoint.commandId !==
      `finalize_${accepted.turn.turnId}_${accepted.cursor.lastSequence}:commit-checkpoint`
  )
    return { ok: false, error: { code: "invalid_persisted_state" } };
  const checkpoint = commitCheckpointCommittedSessionTransaction(
    sql,
    input.checkpoint,
  );
  if (!checkpoint.ok) return checkpoint;
  const stream = completeSessionTurnStream(
    sql,
    input.checkpoint.harnessCheckpoint.turn.turnId,
    input.lastSequence,
    input.completedAt,
  );
  if (!stream.ok) throw new CompositeCommitAbort(stream.error);
  const billing = recordPantryTurnCompletionInTransaction(
    sql,
    input.checkpoint.harnessCheckpoint,
  );
  if (!billing.ok) throw new CompositeCommitAbort(billing.error);
  return checkpoint;
}

export function commitInitializedSessionTransaction(
  sql: SqlStorage,
  input: InitializedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidInitializedSessionTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const outcome: AcceptedActorCommand = {
    kind: "accepted",
    eventId: input.event.eventId,
    sequence: input.event.sequence,
  };
  writeSessionJournalEvent(sql, input.event, envelope.value);
  writeInitializedSessionProjection(sql, input);
  writeInboxAcceptance(sql, input, outcome);
  return { ok: true, value: outcome };
}

export function commitInitializedCaseSessionTransaction(
  sql: SqlStorage,
  input: InitializedCaseSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const state = input.initialization.state.state;
  const receipt =
    state.resumePoint.kind === "new"
      ? state.resumePoint.workspaceRevisionReceipt
      : state.resumePoint.checkpoint.workspaceRevisionReceipt;
  if (
    state.identity.sessionId !== input.assignment.sessionId ||
    state.contract.policyVersion !==
      input.assignment.authorityPartition.policyVersion ||
    state.contract.budgetRevision !== input.assignment.budget.budgetRevision ||
    receipt.revision !== input.assignment.context.workspaceRevision ||
    input.assignment.caseId !== input.assignment.context.caseId ||
    input.assignment.caseRevision !== input.assignment.context.revision
  )
    return { ok: false, error: { code: "invalid_transition" } };

  const payload = JSON.stringify(input.assignment);
  const existing =
    sql
      .exec<Record<string, SqlStorageValue> & { assignment_json: string }>(
        "SELECT assignment_json FROM session_case_parent WHERE singleton = 1",
      )
      .toArray()[0] ?? null;
  if (existing !== null && existing.assignment_json !== payload) {
    return { ok: false, error: { code: "idempotency_conflict" } };
  }
  const committed = commitInitializedSessionTransaction(
    sql,
    input.initialization,
  );
  if (!committed.ok) return committed;
  if (committed.value.kind === "duplicate") {
    if (existing === null) {
      throw new JournalTransitionAbort({ code: "invalid_transition" });
    }
    const budget = readSessionBudgetAccount(sql, {
      organisationId: state.identity.organisationId,
      sessionId: state.identity.sessionId,
    });
    if (!budget.ok) {
      throw new JournalTransitionAbort({
        code:
          budget.error.code === "budget_account_conflict"
            ? "idempotency_conflict"
            : "invalid_transition",
      });
    }
    if (
      !caseAssignmentBudgetMatches(budget.value.budget, input.assignment.budget)
    ) {
      throw new JournalTransitionAbort({ code: "idempotency_conflict" });
    }
    return committed;
  }
  if (existing === null) {
    sql.exec(
      `INSERT INTO session_case_parent
      (singleton, case_id, assignment_id, case_revision, session_id, assignment_json)
      VALUES (1, ?, ?, ?, ?, ?)`,
      input.assignment.caseId,
      input.assignment.assignmentId,
      input.assignment.caseRevision,
      input.assignment.sessionId,
      payload,
    );
  }
  const budget = createSessionBudgetAccount(sql, {
    organisationId: state.identity.organisationId,
    sessionId: state.identity.sessionId,
    operationId: `${input.initialization.commandId}:budget`,
    now: input.initialization.event.acceptedAt,
    budget: input.assignment.budget,
  });
  if (!budget.ok) {
    throw new JournalTransitionAbort({
      code:
        budget.error.code === "budget_account_conflict"
          ? "idempotency_conflict"
          : "invalid_transition",
    });
  }
  return committed;
}

function caseAssignmentBudgetMatches(
  account: CaseAssignment["budget"],
  assignment: CaseAssignment["budget"],
): boolean {
  return (
    account.budgetRevision === assignment.budgetRevision &&
    account.maxTokens === assignment.maxTokens &&
    account.maxWallMs === assignment.maxWallMs &&
    account.maxToolCalls === assignment.maxToolCalls
  );
}

export function readCaseSessionAssignment(
  sql: SqlStorage,
): CaseAssignment | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue> & { assignment_json: string }>(
        "SELECT assignment_json FROM session_case_parent WHERE singleton = 1",
      )
      .toArray()[0] ?? null;
  if (row === null) return null;
  try {
    const value: unknown = JSON.parse(row.assignment_json);
    return parseStoredCaseAssignment(value);
  } catch {
    return null;
  }
}

export function parseStoredCaseAssignment(
  value: unknown,
): CaseAssignment | null {
  return isPersistedCaseAssignment(value) ? value : null;
}

function isPersistedCaseAssignment(value: unknown): value is CaseAssignment {
  if (
    !isRecord(value) ||
    !isRecord(value.objective) ||
    !isRecord(value.authority) ||
    !isRecord(value.authorityPartition) ||
    !isRecord(value.budget) ||
    !isRecord(value.context) ||
    !isRecord(value.context.journalCursor) ||
    !Array.isArray(value.context.entries)
  )
    return false;
  return (
    isNonEmptyString(value.assignmentId) &&
    isNonEmptyString(value.caseId) &&
    Number.isSafeInteger(value.caseRevision) &&
    Number(value.caseRevision) >= 0 &&
    isNonEmptyString(value.sessionId) &&
    (value.role === "coordinator" ||
      value.role === "research" ||
      value.role === "specialist") &&
    isNonEmptyString(value.objective.instruction) &&
    hasExactKeys(value.authority, [
      "capabilityProfile",
      "authorityPartitionDigest",
    ]) &&
    (value.authority.capabilityProfile === "read_and_propose" ||
      value.authority.capabilityProfile === "approved_provider_writes") &&
    typeof value.authority.authorityPartitionDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(value.authority.authorityPartitionDigest) &&
    isPersistedAuthorityPartition(value.authorityPartition) &&
    value.authority.authorityPartitionDigest ===
      value.authorityPartition.digest &&
    isNonEmptyString(value.budget.budgetRevision) &&
    Number.isSafeInteger(value.budget.maxTokens) &&
    Number(value.budget.maxTokens) > 0 &&
    Number.isSafeInteger(value.budget.maxWallMs) &&
    Number(value.budget.maxWallMs) > 0 &&
    Number.isSafeInteger(value.budget.maxToolCalls) &&
    Number(value.budget.maxToolCalls) > 0 &&
    isNonEmptyString(value.context.caseId) &&
    Number.isSafeInteger(value.context.revision) &&
    Number(value.context.revision) >= 0 &&
    isNonEmptyString(value.context.workspaceRevision) &&
    value.context.entries.every(isPersistedContextEntry) &&
    (value.context.journalCursor.kind === "before_first" ||
      (value.context.journalCursor.kind === "accepted" &&
        Number.isSafeInteger(value.context.journalCursor.sequence) &&
        typeof value.context.journalCursor.entryDigest === "string" &&
        /^[0-9a-f]{64}$/u.test(value.context.journalCursor.entryDigest)))
  );
}

function isPersistedAuthorityPartition(
  value: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(value, [
      "digest",
      "key",
      "selectedGrantSetDigest",
      "capabilityKeys",
      "policyVersion",
    ]) ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    !isNonEmptyString(value.policyVersion) ||
    typeof value.selectedGrantSetDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.selectedGrantSetDigest) ||
    !Array.isArray(value.capabilityKeys) ||
    !value.capabilityKeys.every(isNonEmptyString)
  )
    return false;
  return parseStoredAuthorityPartition(value).ok;
}

function isPersistedContextEntry(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.entryId) ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest)
  )
    return false;
  if (value.kind === "inline_preview") return typeof value.preview === "string";
  return (
    value.kind === "artifact" &&
    isRecord(value.artifact) &&
    isNonEmptyString(value.artifact.id) &&
    isNonEmptyString(value.artifact.kind) &&
    (value.artifact.url === null || typeof value.artifact.url === "string")
  );
}

export function commitAcceptedSessionInputTransaction(
  sql: SqlStorage,
  input: AcceptedSessionInputCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);

  if (duplicate !== null) {
    return duplicate;
  }

  const expected = readNextSequence(sql, input.event.streamId);

  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }

  if (!isValidAcceptedInputTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }

  const envelope = JSON.stringify(input.event);
  const encodedBytes = new TextEncoder().encode(envelope).byteLength;

  if (encodedBytes > MAX_EVENT_BYTES) {
    return {
      ok: false,
      error: { code: "journal_event_too_large", encodedBytes },
    };
  }

  const outcome: AcceptedActorCommand = {
    kind: "accepted",
    eventId: input.event.eventId,
    sequence: input.event.sequence,
  };
  writeJournalEvent(sql, input, envelope);
  writeCanonicalSessionProjection(sql, input.state);
  writeInboxAcceptance(sql, input, outcome);

  return {
    ok: true,
    value: {
      kind: "accepted",
      eventId: input.event.eventId,
      sequence: input.event.sequence,
    },
  };
}

export function commitRuntimeActivatedSessionTransaction(
  sql: SqlStorage,
  input: RuntimeActivatedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;

  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidRuntimeActivatedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }

  const envelope = JSON.stringify(input.event);
  const encodedBytes = new TextEncoder().encode(envelope).byteLength;
  if (encodedBytes > MAX_EVENT_BYTES) {
    return {
      ok: false,
      error: { code: "journal_event_too_large", encodedBytes },
    };
  }

  const lease = issueHarnessTurnLeaseInTransaction(
    sql,
    input.state.state,
    input.harnessLease,
    input.event.acceptedAt,
  );
  if (!lease.ok) {
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: lease.error.code },
    };
  }

  const outcome: AcceptedActorCommand = {
    kind: "accepted",
    eventId: input.event.eventId,
    sequence: input.event.sequence,
  };
  writeRuntimeActivatedJournalEvent(sql, input, envelope);
  writeCanonicalSessionProjection(sql, input.state);
  writeInboxAcceptance(sql, input, outcome);
  return { ok: true, value: outcome };
}

export function commitExecutionRecoveryStartedSessionTransaction(
  sql: SqlStorage,
  input: ExecutionRecoveryStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const valid = validateRecoverySessionTransition(sql, input, {
    kind: "begin_execution_recovery",
    continuation: input.state.state.continuation,
    action: input.state.state.action,
  });
  if (!valid.ok) return valid;
  const cursor = input.state.state.continuation.historyCursor;
  const history = sql
    .exec<{ sequence: number; entry_digest: string }>(
      `SELECT sequence, entry_digest FROM session_harness_history
     WHERE organisation_id = ? AND session_id = ? ORDER BY sequence DESC LIMIT 1`,
      input.state.state.identity.organisationId,
      input.state.state.identity.sessionId,
    )
    .toArray()[0];
  if (
    history === undefined ||
    history.sequence !== cursor.lastSequence ||
    history.entry_digest !== cursor.lastEntryDigest
  )
    return { ok: false, error: { code: "invalid_transition" } };
  if (
    JSON.stringify(input.fencedHarnessLease.runtimeLease) !==
      JSON.stringify(input.state.state.fencedRuntime) ||
    input.fencedHarnessLease.session.sessionId !==
      input.state.state.identity.sessionId
  )
    return { ok: false, error: { code: "invalid_transition" } };
  const fenced = fenceHarnessTurnLeaseInTransaction(
    sql,
    input.fencedHarnessLease,
  );
  if (!fenced.ok)
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: fenced.error.code },
    };
  return writeCanonicalTransition(sql, input, valid.value);
}

export function commitExecutionRecoveryUpdatedSessionTransaction(
  sql: SqlStorage,
  input: ExecutionRecoveryUpdatedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const valid = validateRecoverySessionTransition(sql, input, {
    kind: "update_execution_recovery",
    action: input.state.state.action,
  });
  if (!valid.ok) return valid;
  return writeCanonicalTransition(sql, input, valid.value);
}

export function commitExecutionResumedSessionTransaction(
  sql: SqlStorage,
  input: ExecutionResumedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const valid = validateRecoverySessionTransition(sql, input, {
    kind: "resume_execution",
    runtimeLease: input.state.state.runtimeLease,
  });
  if (!valid.ok) return valid;
  const budget = readSessionBudgetAccount(sql, input.state.state.identity);
  if (
    !budget.ok ||
    budget.value.kind !== "open" ||
    budget.value.reservation.kind !== "active"
  )
    return { ok: false, error: { code: "invalid_transition" } };
  const reservation = budget.value.reservation.reservation;
  if (
    reservation.runtimeGeneration !==
      input.harnessLease.runtimeLease.generation ||
    reservation.turnLeaseGeneration !==
      input.harnessLease.turn.turnLeaseGeneration ||
    reservation.turnId !== input.harnessLease.turn.turnId ||
    reservation.budgetRevision !== input.state.state.contract.budgetRevision ||
    reservation.deadlineAt <= input.event.acceptedAt
  )
    return { ok: false, error: { code: "invalid_transition" } };
  const lease = issueHarnessTurnLeaseInTransaction(
    sql,
    input.state.state,
    input.harnessLease,
    input.event.acceptedAt,
  );
  if (!lease.ok)
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: lease.error.code },
    };
  return writeCanonicalTransition(sql, input, valid.value);
}

function validateRecoverySessionTransition(
  sql: SqlStorage,
  input:
    | ExecutionRecoveryStartedSessionCommit
    | ExecutionRecoveryUpdatedSessionCommit
    | ExecutionResumedSessionCommit,
  command: SessionCommand,
): Result<string, ActorTransitionCommitError> {
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected)
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (
    current === null ||
    input.event.organisationId !== input.state.state.identity.organisationId ||
    input.event.actorId !== input.state.state.identity.sessionId ||
    input.event.streamId !== input.state.state.identity.streamId ||
    input.event.sequence !== input.state.state.contract.lastEventSequence ||
    !validateCanonicalSessionAdvance({
      current,
      command,
      transition: input.event.body,
      state: input.state,
    }).ok
  )
    return { ok: false, error: { code: "invalid_transition" } };
  return encodeJournalEvent(input.event);
}

export function commitExecutionSettledSessionTransaction(
  sql: SqlStorage,
  input: ExecutionSettledSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidExecutionSettledTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const lease = preflightHarnessTurnLeaseInTransaction(
    sql,
    input.harnessLease,
    input.event.acceptedAt,
  );
  if (!lease.ok) {
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: lease.error.code },
    };
  }
  const committed = writeCanonicalTransition(sql, input, envelope.value);
  if (!committed.ok) return committed;
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'settled', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND organisation_id = ? AND state_kind = 'dispatching'`,
    JSON.stringify({
      kind: "settled",
      receiptId: input.event.body.receipt.receiptId,
      actorEventId: input.event.eventId,
    }),
    input.event.acceptedAt,
    input.settlementEffectId,
    input.event.organisationId,
  );
  const settled = sql
    .exec<{ state_kind: string }>(
      `SELECT state_kind FROM actor_outbox
     WHERE effect_id = ? AND organisation_id = ? LIMIT 1`,
      input.settlementEffectId,
      input.event.organisationId,
    )
    .toArray()[0];
  if (settled === undefined || settled.state_kind !== "settled") {
    throw new Error("code_mode_settlement_outbox_invalid");
  }
  return committed;
}

export function commitExecutionRequestedSessionTransaction(
  sql: SqlStorage,
  input: ExecutionRequestedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidExecutionRequestedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const lease = preflightHarnessTurnLeaseInTransaction(
    sql,
    input.harnessLease,
    input.event.acceptedAt,
  );
  if (!lease.ok) {
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: lease.error.code },
    };
  }
  const committed = writeCanonicalTransition(sql, input, envelope.value);
  if (!committed.ok) return committed;
  writeExecutionRequest(sql, input);
  return committed;
}

export function commitQuarantinedSessionTransaction(
  sql: SqlStorage,
  input: QuarantinedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidQuarantinedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const committed = writeCanonicalTransition(sql, input, envelope.value);
  if (!committed.ok) return committed;
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'indeterminate', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND organisation_id = ?
       AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify({
      kind: "indeterminate",
      reason: input.indeterminateReason,
      actorEventId: input.event.eventId,
    }),
    input.event.acceptedAt,
    input.settlementEffectId,
    input.event.organisationId,
  );
  const row = sql
    .exec<{ state_kind: string }>(
      `SELECT state_kind FROM actor_outbox
     WHERE effect_id = ? AND organisation_id = ? LIMIT 1`,
      input.settlementEffectId,
      input.event.organisationId,
    )
    .toArray()[0];
  if (row === undefined || row.state_kind !== "indeterminate") {
    throw new Error("code_mode_indeterminate_outbox_invalid");
  }
  return committed;
}

function commitCheckpointingStartedSessionTransaction(
  sql: SqlStorage,
  input: CheckpointingStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;

  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidCheckpointingStartedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const lease = preflightHarnessTurnLeaseInTransaction(
    sql,
    input.harnessLease,
    input.event.acceptedAt,
  );
  if (!lease.ok) {
    return {
      ok: false,
      error: { code: "harness_lease_invalid", reason: lease.error.code },
    };
  }
  return writeCanonicalTransition(sql, input, envelope.value);
}

function commitCheckpointCommittedSessionTransaction(
  sql: SqlStorage,
  input: CheckpointCommittedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;

  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidCheckpointCommittedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const closed = closeCommittedHarnessTurnInTransaction(
    sql,
    input.harnessCheckpoint,
  );
  if (!closed.ok) {
    return {
      ok: false,
      error: { code: "harness_checkpoint_invalid", reason: closed.error.code },
    };
  }
  return writeCanonicalTransition(sql, input, envelope.value);
}

function commitCancellationStartedSessionTransaction(
  sql: SqlStorage,
  input: CancellationStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  if (!isValidCancellationStartedTransition(sql, input)) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  if (input.harnessLease !== undefined) {
    const fenced = fenceHarnessTurnLeaseInTransaction(sql, input.harnessLease);
    if (!fenced.ok) {
      return {
        ok: false,
        error: { code: "harness_lease_invalid", reason: fenced.error.code },
      };
    }
  }
  return writeCanonicalTransition(sql, input, envelope.value);
}

function commitCancellationResolvedSessionTransaction(
  sql: SqlStorage,
  input: CancellationResolvedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const duplicate = readDuplicateAcceptance(sql, input);
  if (duplicate !== null) return duplicate;
  const expected = readNextSequence(sql, input.event.streamId);
  if (input.event.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "journal_sequence_gap",
        expected,
        received: input.event.sequence,
      },
    };
  }
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (
    current === null ||
    current.kind !== "cancelling" ||
    !isValidCancellationResolvedTransition(current, input)
  ) {
    return { ok: false, error: { code: "invalid_transition" } };
  }
  const envelope = encodeJournalEvent(input.event);
  if (!envelope.ok) return envelope;
  const running = readRunningSessionTurn(sql);
  if (!running.ok)
    return { ok: false, error: { code: "invalid_persisted_state" } };
  const committed = writeCanonicalTransition(sql, input, envelope.value);
  if (!committed.ok) return committed;
  const turnId =
    current.state.plan.kind === "turn"
      ? current.state.plan.turnId
      : (running.value?.turnId ?? null);
  if (input.state.kind !== "checkpointing" && turnId !== null) {
    const billing = recordPantryTurnCancellationInTransaction(sql, {
      turnId,
      sourceRecordId: input.event.eventId,
      canonicalReceipt: canonicalJson({
        eventId: input.event.eventId,
        streamId: input.event.streamId,
        sequence: input.event.sequence,
        turnId,
        resolution: input.state.kind,
        acceptedAt: input.event.acceptedAt,
      }),
      occurredAt: input.event.acceptedAt,
    });
    if (!billing.ok) throw new JournalTransitionAbort(billing.error);
  }
  if (
    input.state.kind === "terminal" &&
    current.state.plan.kind === "session"
  ) {
    const billing = recordPantrySessionCancellationInTransaction(sql, {
      sessionId: current.state.identity.sessionId,
      sourceRecordId: input.event.eventId,
      sequence: input.event.sequence,
      occurredAt: input.event.acceptedAt,
    });
    if (!billing.ok) throw new JournalTransitionAbort(billing.error);
  }
  return committed;
}

function writeCanonicalTransition(
  sql: SqlStorage,
  input:
    | ExecutionRequestedSessionCommit
    | ExecutionSettledSessionCommit
    | ExecutionRecoveryStartedSessionCommit
    | ExecutionRecoveryUpdatedSessionCommit
    | ExecutionResumedSessionCommit
    | SessionQuarantineCommit
    | TerminatedSessionCommit
    | CheckpointingStartedSessionCommit
    | CheckpointCommittedSessionCommit
    | CancellationStartedSessionCommit
    | CancellationResolvedSessionCommit,
  envelope: string,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  const outcome: AcceptedActorCommand = {
    kind: "accepted",
    eventId: input.event.eventId,
    sequence: input.event.sequence,
  };
  writeSessionJournalEvent(sql, input.event, envelope);
  writeCanonicalSessionProjection(sql, input.state);
  writeInboxAcceptance(sql, input, outcome);
  return { ok: true, value: outcome };
}

function encodeJournalEvent(
  event: EventEnvelope<SessionTransition>,
): Result<
  string,
  VariantBy<ActorTransitionCommitError, "code", "journal_event_too_large">
> {
  const envelope = JSON.stringify(event);
  const encodedBytes = new TextEncoder().encode(envelope).byteLength;
  return encodedBytes <= MAX_EVENT_BYTES
    ? { ok: true, value: envelope }
    : { ok: false, error: { code: "journal_event_too_large", encodedBytes } };
}

function writeInitializedSessionProjection(
  sql: SqlStorage,
  input: InitializedSessionCommit,
): void {
  sql.exec(
    `INSERT INTO session_meta (
       session_id, organisation_id, thread_key, track, lifecycle_kind,
       lifecycle_projection, last_event_sequence, policy_version,
       started_at, terminal_at
     ) VALUES (?, ?, ?, ?, 'sleeping', ?, ?, ?, ?, NULL)`,
    input.state.state.identity.sessionId,
    input.state.state.identity.organisationId,
    input.projection.threadKey,
    input.projection.track,
    JSON.stringify(input.state),
    input.state.state.contract.lastEventSequence,
    input.state.state.contract.policyVersion,
    input.projection.startedAt,
  );
}

function isValidInitializedSessionTransition(
  sql: SqlStorage,
  input: InitializedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current !== null) return false;
  const transition = input.event.body;
  const validation = validateCanonicalSessionAdvance({
    current: null,
    command: {
      kind: "initialize",
      identity: transition.state.identity,
      contract: transition.state.contract,
      resumePoint: transition.state.resumePoint,
    },
    transition,
    state: input.state,
  });
  return (
    validation.ok &&
    JSON.stringify(transition.state) === JSON.stringify(input.state.state) &&
    input.projection.threadKey.length > 0 &&
    Number.isSafeInteger(input.projection.startedAt) &&
    input.projection.startedAt >= 0 &&
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence
  );
}

function isValidAcceptedInputTransition(
  sql: SqlStorage,
  input: AcceptedSessionInputCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "sleeping") return false;
  const transition = input.event.body;
  const command: SessionCommand = {
    kind: "accept_input",
    input: transition.input,
    turnId: transition.state.turnId,
    runtimeGeneration: transition.state.runtimeGeneration,
  };
  const validation = validateCanonicalSessionAdvance({
    current,
    command,
    transition,
    state: input.state,
  });
  if (!validation.ok) return false;
  return (
    input.event.organisationId === input.state.state.identity.organisationId &&
    input.event.actorId === input.state.state.identity.sessionId &&
    input.event.streamId === input.state.state.identity.streamId &&
    input.event.sequence === input.state.state.contract.lastEventSequence
  );
}

function isValidRuntimeActivatedTransition(
  sql: SqlStorage,
  input: RuntimeActivatedSessionCommit,
): boolean {
  const current = readCanonicalSessionProjection(
    sql,
    input.event.organisationId,
    input.event.actorId,
  );
  if (current === null || current.kind !== "activating") return false;
  const activeTurn = input.state.state.activeTurn;
  if (activeTurn.kind !== "admitted") return false;
  const command: SessionCommand = {
    kind: "activate_runtime",
    runtimeLease: input.state.state.runtimeLease,
    turnLeaseGeneration: activeTurn.state.identity.turnLeaseGeneration,
    admittedAt: activeTurn.state.admittedAt,
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
    input.event.sequence === input.state.state.contract.lastEventSequence
  );
}
