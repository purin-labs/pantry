import {
  parseProjectSnapshot,
  restoreStoredProjectSnapshot,
  verifyProjectSnapshot,
  type ProjectSnapshot,
} from "@seams/control-api";
import type {
  AcceptedInputRef,
  AgentSessionLifecycle,
  CaseAssignment,
  CancellationLease,
  CancellationPlan,
  EventEnvelope,
  HarnessCheckpointRecord,
  HarnessTurnLease,
  RunBudgetReservation,
  SessionTransition,
  Sha256Digest,
  StoredMessageAttachment,
} from "@seams/contracts";
import type { Result } from "../result";
import type { CodeModeOrganisationReserveInput } from "./code-mode-budget";
import type { SessionBudgetError } from "./agent-session-budget";
import type { HarnessAuthorityError } from "./agent-session-harness-authority";
import type { SessionTurnStreamError } from "./agent-session-turn-stream";
import type { SessionTurnInputDigest } from "./agent-session-turn-input-digest";
import type { RequestId, OrganisationId } from "../ids";
import type { SessionInformationFlowCommit } from "./agent-session-information-flow";
import {
  digestContextBundle,
  digestHistoricalContextBundle,
  materializeContextBundle,
  type ContextBundle,
  type ModelContextBundle,
} from "../context/assembly";
import type { Variant } from "@seams/type-utils";
import { hasExactKeys, isRecord } from "@seams/std";
import {
  CompositeCommitAbort,
  JournalTransitionAbort,
  StartedSessionBudgetAbort,
} from "./actor-journal/aborts";
import {
  parseAcceptedInputEnvelope,
  parseContextBundle,
  parseStoredTurnContext,
} from "./actor-journal/parsers";
import {
  commitAcceptedSessionInputTransaction,
  commitCompletedSessionTurnTransaction,
  commitExecutionRecoveryStartedSessionTransaction,
  commitExecutionRecoveryUpdatedSessionTransaction,
  commitExecutionRequestedSessionTransaction,
  commitExecutionResumedSessionTransaction,
  commitExecutionSettledSessionTransaction,
  commitInitializedCaseSessionTransaction,
  commitInitializedSessionTransaction,
  commitQuarantinedSessionTransaction,
  commitRuntimeActivatedSessionTransaction,
  commitStartedSessionTransaction,
} from "./actor-journal/transactions";

export type InputAcceptedTransition = Variant<
  SessionTransition,
  "input_accepted"
>;

export type SessionInitializedTransition = Variant<
  SessionTransition,
  "session_initialized"
>;

export type RuntimeActivatedTransition = Variant<
  SessionTransition,
  "runtime_activated"
>;

export type ExecutionRequestedTransition = Variant<
  SessionTransition,
  "execution_requested"
>;

export type ExecutionSettledTransition = Variant<
  SessionTransition,
  "execution_settled"
>;

export type SessionQuarantinedTransition = Variant<
  SessionTransition,
  "session_quarantined"
>;

export type SessionTerminatedTransition = Variant<
  SessionTransition,
  "session_terminated"
>;

export type CheckpointingStartedTransition = Variant<
  SessionTransition,
  "checkpointing_started"
>;

export type CheckpointCommittedTransition = Variant<
  SessionTransition,
  "checkpoint_committed"
>;

export type CancellationStartedTransition = Variant<
  SessionTransition,
  "cancellation_started"
>;

export type CancellationResolvedTransition = Variant<
  SessionTransition,
  "cancellation_resolved"
>;

export type ActorInboxSource =
  | "capacity_governor"
  | "integration_gateway"
  | "surface_actor"
  | "case_actor"
  | "organisation_actor"
  | "harness"
  | "scheduler"
  | "operator"
  | "migration";

export type AcceptedActorCommand = {
  kind: "accepted";
  eventId: string;
  sequence: number;
};

export type ActorTransitionCommitResult =
  | { kind: "accepted"; eventId: string; sequence: number }
  | { kind: "duplicate"; eventId: string; sequence: number };

export type ActorTransitionCommitError =
  | { code: "activation_schema_advance_failed" }
  | { code: "already_cut_over" }
  | { code: "idempotency_conflict" }
  | { code: "invalid_persisted_state" }
  | { code: "invalid_transition" }
  | { code: "source_authority_not_drained" }
  | { code: "source_schema_mismatch"; expected: number; received: number }
  | { code: "journal_sequence_gap"; expected: number; received: number }
  | { code: "journal_event_too_large"; encodedBytes: number }
  | { code: "harness_lease_invalid"; reason: HarnessAuthorityError["code"] }
  | {
      code: "harness_checkpoint_invalid";
      reason: HarnessAuthorityError["code"];
    }
  | { code: "snapshot_invalid" };

export type AcceptedSessionInputCommit = {
  source: Extract<ActorInboxSource, "surface_actor">;
  commandId: string;
  event: EventEnvelope<InputAcceptedTransition>;
  state: Variant<AgentSessionLifecycle, "activating">;
};

export type InitializedSessionCommit = {
  source: Extract<ActorInboxSource, "surface_actor" | "case_actor">;
  commandId: string;
  event: EventEnvelope<SessionInitializedTransition>;
  state: Variant<AgentSessionLifecycle, "sleeping">;
  projection: {
    threadKey: string;
    track: "managed-agents" | "byo";
    startedAt: number;
  };
};

export type InitializedCaseSessionCommit = {
  readonly initialization: InitializedSessionCommit & {
    readonly source: "case_actor";
  };
  readonly assignment: CaseAssignment;
};

export type StartedSessionCommit = {
  acceptedInput: AcceptedSessionInputCommit;
  activatedRuntime: RuntimeActivatedSessionCommit;
  attachments: readonly StoredMessageAttachment[];
  /** Links the message carried, so the link tool can be scoped to them. */
  links?: readonly string[];
  context: SessionTurnContext;
  informationFlow: SessionInformationFlowCommit;
  stream: {
    turnId: string;
    requestId: RequestId;
    organisationId: OrganisationId;
    inputDigest: SessionTurnInputDigest;
    startedAt: number;
  };
};

/**
 * A bundle accepted before Memory admission. It records no Memory outcome, and
 * its stored form and digest are the ones it had then. Only stored turns
 * produce one.
 */
export type HistoricalContextBundle = Omit<ContextBundle, "memory"> &
  Readonly<{ memory?: never }>;

export type StoredContextBundle = ContextBundle | HistoricalContextBundle;

export type SessionTurnContext = {
  readonly projectContext: ProjectSnapshot | null;
  readonly bundle: StoredContextBundle;
  readonly bundleDigest: Sha256Digest;
  readonly modelContext: ModelContextBundle;
};

/**
 * The Memory revisions one turn's prompt actually carried, and whether the
 * prompt's byte budget withheld any that the bundle admitted.
 */
export type SessionTurnMemoryRendering = Readonly<{
  revisions: readonly Readonly<{ memoryId: string; revision: number }>[];
  omittedForBytes: boolean;
}>;

export type SessionTurnContextLookup = {
  readonly turnId: string;
  readonly organisationId: string;
  readonly sessionId: string;
};

export type SessionTurnContextReadError =
  | { readonly code: "project_evidence_unavailable" }
  | { readonly code: "session_turn_context_missing" }
  | { readonly code: "invalid_persisted_state" };

export type StartedSessionCommitError =
  ActorTransitionCommitError | SessionTurnStreamError | SessionBudgetError;

export type StartedSessionCommitResult = {
  acceptedInput: ActorTransitionCommitResult;
  activatedRuntime: ActorTransitionCommitResult;
  stream: "started" | "existing";
  reservation: RunBudgetReservation;
  flowBinding: SessionInformationFlowCommit["binding"];
};

export type CompletedSessionTurnCommit = {
  checkpoint: CheckpointCommittedSessionCommit;
  lastSequence: number;
  completedAt: number;
};

export type RuntimeActivatedSessionCommit = {
  source: Extract<ActorInboxSource, "capacity_governor">;
  commandId: string;
  event: EventEnvelope<RuntimeActivatedTransition>;
  state: Variant<AgentSessionLifecycle, "processing">;
  harnessLease: HarnessTurnLease;
};

export type ExecutionRecoveryStartedSessionCommit = {
  source: Extract<ActorInboxSource, "scheduler">;
  commandId: string;
  event: EventEnvelope<
    Variant<SessionTransition, "execution_recovery_started">
  >;
  state: Variant<AgentSessionLifecycle, "recovering">;
  fencedHarnessLease: HarnessTurnLease;
  harnessLease?: never;
};

export type ExecutionRecoveryUpdatedSessionCommit = {
  source: Extract<ActorInboxSource, "scheduler">;
  commandId: string;
  event: EventEnvelope<
    Variant<SessionTransition, "execution_recovery_updated">
  >;
  state: Variant<AgentSessionLifecycle, "recovering">;
  harnessLease?: never;
};

export type ExecutionResumedSessionCommit = {
  source: Extract<ActorInboxSource, "capacity_governor">;
  commandId: string;
  event: EventEnvelope<Variant<SessionTransition, "execution_resumed">>;
  state: Variant<AgentSessionLifecycle, "processing">;
  harnessLease: HarnessTurnLease;
};

export type ExecutionSettledSessionCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<ExecutionSettledTransition>;
  state: Variant<AgentSessionLifecycle, "processing">;
  harnessLease: HarnessTurnLease;
  settlementEffectId: string;
};

export type ExecutionRequestedSessionCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<ExecutionRequestedTransition>;
  state: Variant<AgentSessionLifecycle, "processing">;
  harnessLease: HarnessTurnLease;
  reserve: CodeModeOrganisationReserveInput;
};

export type SessionQuarantineCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<SessionQuarantinedTransition>;
  state: Variant<AgentSessionLifecycle, "quarantined">;
};

export type QuarantinedSessionCommit = SessionQuarantineCommit & {
  settlementEffectId: string;
  indeterminateReason: string;
};

export type TerminatedSessionCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<SessionTerminatedTransition>;
  state: Variant<AgentSessionLifecycle, "terminal">;
};

export type CheckpointingStartedSessionCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<CheckpointingStartedTransition>;
  state: Variant<AgentSessionLifecycle, "checkpointing">;
  harnessLease: HarnessTurnLease;
};

export type CheckpointCommittedSessionCommit = {
  source: Extract<ActorInboxSource, "harness">;
  commandId: string;
  event: EventEnvelope<CheckpointCommittedTransition>;
  state: Variant<AgentSessionLifecycle, "sleeping"> & {
    state: {
      resumePoint: Variant<
        Variant<AgentSessionLifecycle, "sleeping">["state"]["resumePoint"],
        "checkpoint"
      >;
    };
  };
  harnessLease?: never;
  harnessCheckpoint: HarnessCheckpointRecord;
};

export type CancellationStartedSessionCommitFields = {
  source: Extract<ActorInboxSource, "operator" | "surface_actor">;
  commandId: string;
  event: EventEnvelope<CancellationStartedTransition>;
};

export type ActiveLeaseCancellationStartedSessionCommit =
  CancellationStartedSessionCommitFields & {
    state: Variant<AgentSessionLifecycle, "cancelling"> & {
      state: {
        plan: CancellationPlan & {
          lease: Variant<CancellationLease, "active">;
        };
      };
    };
    harnessLease: HarnessTurnLease;
  };

export type FencedCancellationStartedSessionCommit =
  CancellationStartedSessionCommitFields & {
    state: Variant<AgentSessionLifecycle, "cancelling"> & {
      state: {
        plan: CancellationPlan & { lease: Variant<CancellationLease, "none"> };
      };
    };
    harnessLease?: never;
  };

export type CancellationStartedSessionCommit =
  | ActiveLeaseCancellationStartedSessionCommit
  | FencedCancellationStartedSessionCommit;

export type CancellationResolvedSessionCommit = {
  source: Extract<ActorInboxSource, "operator" | "harness">;
  commandId: string;
  event: EventEnvelope<CancellationResolvedTransition>;
  state: Variant<
    AgentSessionLifecycle,
    "sleeping" | "checkpointing" | "terminal"
  >;
};

export type JournaledSessionCommit =
  | InitializedSessionCommit
  | AcceptedSessionInputCommit
  | RuntimeActivatedSessionCommit
  | ExecutionRecoveryStartedSessionCommit
  | ExecutionRecoveryUpdatedSessionCommit
  | ExecutionResumedSessionCommit
  | ExecutionRequestedSessionCommit
  | ExecutionSettledSessionCommit
  | QuarantinedSessionCommit
  | TerminatedSessionCommit
  | CheckpointingStartedSessionCommit
  | CheckpointCommittedSessionCommit
  | CancellationStartedSessionCommit
  | CancellationResolvedSessionCommit;

export type ActorTransactionStorage = {
  sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
};

export type ActorInboxRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  operation_id: string;
  outcome: string;
};

export type ActorJournalEnvelopeRow = Record<string, SqlStorageValue> & {
  envelope: string;
};

export type HarnessLeaseProjectionRow = Record<string, SqlStorageValue> & {
  lease_projection: string;
};

export type SessionTurnContextRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  bundle_digest: string;
  bundle_json: string;
};

export type AcceptedInputEnvelopeRow = Record<string, SqlStorageValue> & {
  envelope: string;
};

export type AcceptedInputLookup = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly turnId: string;
  readonly inputId: string;
};

export type AcceptedInputReadError =
  | { readonly code: "accepted_input_missing" }
  | { readonly code: "invalid_persisted_state" };

export function createSessionTurnContextSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_turn_context (
      turn_id TEXT PRIMARY KEY CHECK (length(turn_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      bundle_digest TEXT NOT NULL CHECK (
        length(bundle_digest) = 64 AND bundle_digest NOT GLOB '*[^0-9a-f]*'
      ),
      bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json))
    )`,
  );
}

export async function restoreSessionTurnContext(
  value: unknown,
): Promise<SessionTurnContext | null> {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, [
        "bundle",
        "bundleDigest",
        "modelContext",
        "projectContext",
      ]) || hasExactKeys(value, ["bundle", "bundleDigest", "modelContext"])
    ) ||
    typeof value.bundleDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.bundleDigest)
  ) {
    return null;
  }
  const projectContext =
    value.projectContext === undefined || value.projectContext === null
      ? null
      : parseProjectSnapshot(value.projectContext);
  if (
    (value.projectContext !== undefined &&
      value.projectContext !== null &&
      projectContext === null) ||
    (projectContext !== null && !(await verifyProjectSnapshot(projectContext)))
  )
    return null;
  const bundle = await restoreContextBundle(value.bundle);
  if (
    bundle === null ||
    (await digestStoredContextBundle(bundle)) !== value.bundleDigest
  )
    return null;
  const modelContext = materializeContextBundle(bundle);
  return JSON.stringify(value.modelContext) === JSON.stringify(modelContext)
    ? { bundle, bundleDigest: value.bundleDigest, modelContext, projectContext }
    : null;
}

export async function restoreContextBundle(
  value: unknown,
): Promise<StoredContextBundle | null> {
  return parseContextBundle(value);
}

export function digestStoredContextBundle(
  bundle: StoredContextBundle,
): Promise<Sha256Digest> {
  return bundle.memory === undefined
    ? digestHistoricalContextBundle(bundle)
    : digestContextBundle(bundle);
}

export async function readSessionTurnModelContext(
  sql: SqlStorage,
  lookup: SessionTurnContextLookup,
): Promise<Result<SessionTurnContext, SessionTurnContextReadError>> {
  const rows = sql
    .exec<SessionTurnContextRow>(
      `SELECT organisation_id, session_id, bundle_digest, bundle_json
     FROM session_turn_context
     WHERE turn_id = ?`,
      lookup.turnId,
    )
    .toArray();
  if (rows.length === 0) {
    return { ok: false, error: { code: "session_turn_context_missing" } };
  }
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    row === undefined ||
    row.organisation_id !== lookup.organisationId ||
    row.session_id !== lookup.sessionId ||
    !/^[0-9a-f]{64}$/u.test(row.bundle_digest)
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  let rawBundle: unknown;
  try {
    rawBundle = JSON.parse(row.bundle_json);
  } catch {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  const storedContext = parseStoredTurnContext(rawBundle);
  if (
    isRecord(rawBundle) &&
    restoreStoredProjectSnapshot(rawBundle.projectContext).kind ===
      "evidence_unavailable"
  ) {
    return { ok: false, error: { code: "project_evidence_unavailable" } };
  }
  if (storedContext === null)
    return { ok: false, error: { code: "invalid_persisted_state" } };
  const projectContext = storedContext.projectContext;
  if (projectContext !== null && !(await verifyProjectSnapshot(projectContext)))
    return { ok: false, error: { code: "invalid_persisted_state" } };
  const bundle = await parseContextBundle(storedContext.bundle);
  if (
    bundle === null ||
    bundle.organisationId !== lookup.organisationId ||
    bundle.sessionId !== lookup.sessionId
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  const modelContext = materializeContextBundle(bundle);
  return {
    ok: true,
    value: {
      bundle,
      bundleDigest: row.bundle_digest,
      modelContext,
      projectContext,
    },
  };
}

export function commitAcceptedSessionInput(
  storage: ActorTransactionStorage,
  input: AcceptedSessionInputCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitAcceptedSessionInputTransaction.bind(null, storage.sql, input),
  );
}

export function commitInitializedSession(
  storage: ActorTransactionStorage,
  input: InitializedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitInitializedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitInitializedCaseSession(
  storage: ActorTransactionStorage,
  input: InitializedCaseSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  try {
    return storage.transactionSync(
      commitInitializedCaseSessionTransaction.bind(null, storage.sql, input),
    );
  } catch (error) {
    if (error instanceof JournalTransitionAbort) {
      return { ok: false, error: error.commitError };
    }
    throw error;
  }
}

export function commitStartedSession(
  storage: ActorTransactionStorage,
  input: StartedSessionCommit,
): Result<StartedSessionCommitResult, StartedSessionCommitError> {
  try {
    return storage.transactionSync(
      commitStartedSessionTransaction.bind(null, storage.sql, input),
    );
  } catch (error) {
    if (error instanceof StartedSessionBudgetAbort) {
      return { ok: false, error: error.budgetError };
    }
    if (error instanceof CompositeCommitAbort) {
      return { ok: false, error: error.commitError };
    }
    throw error;
  }
}

export function commitCompletedSessionTurn(
  storage: ActorTransactionStorage,
  input: CompletedSessionTurnCommit,
): Result<
  ActorTransitionCommitResult,
  ActorTransitionCommitError | SessionTurnStreamError
> {
  try {
    return storage.transactionSync(
      commitCompletedSessionTurnTransaction.bind(null, storage.sql, input),
    );
  } catch (error) {
    if (error instanceof CompositeCommitAbort) {
      return { ok: false, error: error.commitError };
    }
    throw error;
  }
}

export function readAcceptedSessionInput(
  sql: SqlStorage,
  lookup: AcceptedInputLookup,
): Result<AcceptedInputRef, AcceptedInputReadError> {
  const rows = sql
    .exec<AcceptedInputEnvelopeRow>(
      `SELECT envelope
     FROM actor_journal
     WHERE organisation_id = ? AND stream_id = ?
       AND json_extract(envelope, '$.body.kind') = 'input_accepted'
       AND json_extract(envelope, '$.body.input.inputId') = ?
     ORDER BY sequence DESC
     LIMIT 2`,
      lookup.organisationId,
      lookup.streamId,
      lookup.inputId,
    )
    .toArray();
  if (rows.length === 0) {
    return { ok: false, error: { code: "accepted_input_missing" } };
  }
  if (rows.length !== 1) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  const row = rows[0];
  return row === undefined
    ? { ok: false, error: { code: "invalid_persisted_state" } }
    : parseAcceptedInputEnvelope(row.envelope, lookup);
}

export function commitRuntimeActivatedSession(
  storage: ActorTransactionStorage,
  input: RuntimeActivatedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitRuntimeActivatedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitExecutionRecoveryStartedSession(
  storage: ActorTransactionStorage,
  input: ExecutionRecoveryStartedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitExecutionRecoveryStartedSessionTransaction.bind(
      null,
      storage.sql,
      input,
    ),
  );
}

export function commitExecutionRecoveryUpdatedSession(
  storage: ActorTransactionStorage,
  input: ExecutionRecoveryUpdatedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitExecutionRecoveryUpdatedSessionTransaction.bind(
      null,
      storage.sql,
      input,
    ),
  );
}

export function commitExecutionResumedSession(
  storage: ActorTransactionStorage,
  input: ExecutionResumedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitExecutionResumedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitExecutionSettledSession(
  storage: ActorTransactionStorage,
  input: ExecutionSettledSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitExecutionSettledSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitExecutionRequestedSession(
  storage: ActorTransactionStorage,
  input: ExecutionRequestedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitExecutionRequestedSessionTransaction.bind(null, storage.sql, input),
  );
}

export function commitQuarantinedSession(
  storage: ActorTransactionStorage,
  input: QuarantinedSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return storage.transactionSync(
    commitQuarantinedSessionTransaction.bind(null, storage.sql, input),
  );
}
