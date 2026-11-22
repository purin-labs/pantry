import type {
  AgentSessionLifecycle,
  HarnessTaskContinuation,
  SessionRecoveryAction,
  SessionRecoveryEvidence,
  SessionBudgetUsage,
  SessionContract,
  SessionIdentity,
  VerifiedSessionCheckpoint,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";

import { validateCanonicalSessionRestore } from "../actor-wasm";
import { parseSessionModelRoute } from "@purin-labs/authority/policy-snapshot";
import type { Result } from "@purin-labs/kernel/result";
import { parseWorkspaceReceipt } from "../workspace-revision-store";
import { type AgentSessionPersistence } from "./agent-session-schema";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import type { Variant } from "@purin-labs/type-utils";
import {
  isNonNegativeInteger,
  hasExactKeys,
  isRecord,
  positiveIntegerOrNull,
  sha256Hex,
} from "@purin-labs/std";

export type ImportedCanonicalSessionLifecycle = AgentSessionLifecycle;

export type ImportedCanonicalSessionRecord = {
  organisationId: string;
  sessionId: string;
  threadKey: string;
  track: "managed-agents" | "byo";
  startedAt: number;
  lifecycle: ImportedCanonicalSessionLifecycle;
};

export type CanonicalSessionReadError =
  | { code: "canonical_session_missing" }
  | { code: "canonical_session_organisation_mismatch" }
  | { code: "canonical_session_corrupt" }
  | { code: "canonical_session_lifecycle_unsupported" };

export type CanonicalSessionAccessError =
  CanonicalSessionReadError | { code: "canonical_session_schema_mismatch" };

type CanonicalSnapshotRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  stream_id: string;
  last_sequence: number;
  reducer_schema_version: number;
  state_digest: string;
  state_projection: string;
};

type CanonicalJournalRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  stream_id: string;
  sequence: number;
  event_id: string;
  envelope: string;
};

type CanonicalInboxRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  source: string;
  idempotency_key: string;
  operation_id: string;
  outcome: string;
};

type CanonicalActivationRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  object_kind: string;
  logical_object_id: string;
  schema_version: number;
};

type CanonicalSessionRow = Record<string, SqlStorageValue> & {
  session_id: string;
  organisation_id: string;
  thread_key: string;
  track: string;
  lifecycle_kind: string;
  lifecycle_projection: string;
  last_event_sequence: number;
  policy_version: string;
  started_at: number;
  terminal_at: number | null;
};

type ImportedTurnIdentity = {
  turnId: string;
  inputId: string;
  turnLeaseGeneration: number;
  budgetRevision: string;
};

type ImportedProcessingTurn =
  | {
      kind: "admitted";
      state: { identity: ImportedTurnIdentity; admittedAt: number };
    }
  | {
      kind: "awaiting_execution";
      state: {
        identity: ImportedTurnIdentity;
        executionId: string;
        effectId: string;
      };
    }
  | {
      kind: "reducing_result";
      state: {
        identity: ImportedTurnIdentity;
        receiptId: string;
        workspaceRevisionReceipt: WorkspaceRevisionReceipt;
      };
    };

export function readImportedCanonicalSession(
  sql: SqlStorage,
  requestingOrganisationId: string,
): Result<ImportedCanonicalSessionRecord, CanonicalSessionReadError> {
  const row = readImportedCanonicalSessionRow(sql, requestingOrganisationId);
  return row.ok ? { ok: true, value: row.value.record } : row;
}

/** The Session record with the stored text of its state projection. */
function readImportedCanonicalSessionRow(
  sql: SqlStorage,
  requestingOrganisationId: string,
): Result<
  {
    readonly record: ImportedCanonicalSessionRecord;
    readonly projection: string;
  },
  CanonicalSessionReadError
> {
  const rows = sql
    .exec<CanonicalSessionRow>(
      `SELECT session_id, organisation_id, thread_key, track, lifecycle_kind,
              lifecycle_projection, last_event_sequence, policy_version,
              started_at, terminal_at
       FROM session_meta
       LIMIT 2`,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined)
    return { ok: false, error: { code: "canonical_session_missing" } };
  if (rows.length !== 1) return corruptSession();
  if (row.organisation_id !== requestingOrganisationId) {
    return {
      ok: false,
      error: { code: "canonical_session_organisation_mismatch" },
    };
  }
  const lifecycle = parseImportedCanonicalLifecycle(row.lifecycle_projection);
  if (!lifecycle.ok) return lifecycle;
  if (!rowMatchesLifecycle(row, lifecycle.value)) return corruptSession();
  if (!validTrack(row.track) || !isNonNegativeInteger(row.started_at))
    return corruptSession();
  return {
    ok: true,
    value: {
      record: {
        organisationId: row.organisation_id,
        sessionId: row.session_id,
        threadKey: row.thread_key,
        track: row.track,
        startedAt: row.started_at,
        lifecycle: lifecycle.value,
      },
      projection: row.lifecycle_projection,
    },
  };
}

export function readCanonicalSessionProjection(
  sql: SqlStorage,
  organisationId: string,
  sessionId: string,
): AgentSessionLifecycle | null {
  const rows = sql
    .exec<{ lifecycle_projection: string }>(
      `SELECT lifecycle_projection
       FROM session_meta
       WHERE organisation_id = ? AND session_id = ?
       LIMIT 2`,
      organisationId,
      sessionId,
    )
    .toArray();
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return null;
  const lifecycle = parseImportedCanonicalLifecycle(row.lifecycle_projection);
  return lifecycle.ok ? lifecycle.value : null;
}

export function writeCanonicalSessionProjection(
  sql: SqlStorage,
  state: AgentSessionLifecycle,
): void {
  const terminalAt = state.kind === "terminal" ? state.state.terminalAt : null;
  sql.exec(
    `UPDATE session_meta
     SET lifecycle_kind = ?, lifecycle_projection = ?, last_event_sequence = ?,
         policy_version = ?, terminal_at = ?
     WHERE organisation_id = ? AND session_id = ?`,
    state.kind,
    JSON.stringify(state),
    state.state.contract.lastEventSequence,
    state.state.contract.policyVersion,
    terminalAt,
    state.state.identity.organisationId,
    state.state.identity.sessionId,
  );
  const persisted = readCanonicalSessionProjection(
    sql,
    state.state.identity.organisationId,
    state.state.identity.sessionId,
  );
  if (persisted === null || !sameLifecycle(persisted, state)) {
    throw new Error("canonical_session_projection_write_failed");
  }
}

/**
 * The last point at which one Actor instance verified its Session: a journal
 * sequence, the event at it, and the text of the state projection that the
 * replay of the journal gave there.
 *
 * A verified read replays the journal from its snapshot or its first event.
 * The journal only grows, so a replay from a verified point gives the same
 * result for less work: the events after the point are replayed from the
 * state that was verified at it. The point is used only while the journal
 * still holds the same event at its sequence. A read that the point does not
 * verify takes the whole replay, which decides it as before.
 *
 * The point lives in memory with the Actor instance. A new instance verifies
 * the whole journal one time.
 */
type VerifiedSessionPoint = {
  readonly organisationId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly projection: string;
};

const VERIFIED_SESSION_POINTS = new WeakMap<
  AgentSessionPersistence,
  VerifiedSessionPoint
>();

async function readVerifiedImportedCanonicalSession(
  sql: SqlStorage,
  requestingOrganisationId: string,
  persistence?: AgentSessionPersistence,
): Promise<Result<ImportedCanonicalSessionRecord, CanonicalSessionReadError>> {
  const row = readImportedCanonicalSessionRow(sql, requestingOrganisationId);
  if (!row.ok) return row;
  const session = { ok: true as const, value: row.value.record };

  const { lifecycle } = session.value;
  const { identity, contract } = lifecycle.state;
  if (!hasCanonicalSchema(sql) || !hasCanonicalActivation(sql, identity)) {
    return corruptSession();
  }

  const point =
    persistence === undefined
      ? undefined
      : VERIFIED_SESSION_POINTS.get(persistence);
  if (persistence !== undefined && point !== undefined) {
    const advanced = verifyFromSessionPoint(
      sql,
      point,
      lifecycle,
      row.value.projection,
    );
    if (advanced !== null) {
      VERIFIED_SESSION_POINTS.set(persistence, advanced);
      return session;
    }
  }

  const base = await readVerifiedCanonicalBase(
    sql,
    identity.streamId,
    contract.lastEventSequence,
    lifecycle,
  );
  if (base === null) return corruptSession();
  if (
    base.journal.organisation_id !== identity.organisationId ||
    base.journal.stream_id !== identity.streamId ||
    base.journal.sequence !== base.sequence ||
    base.journal.event_id !== base.event.eventId
  ) {
    return corruptSession();
  }

  const inbox = readOneAcceptance(
    sql,
    base.event.source,
    base.event.idempotencyKey,
  );
  if (
    inbox === null ||
    !inboxMatchesEvent(inbox, identity.organisationId, base.event)
  ) {
    return corruptSession();
  }
  const tail = readJournalTail(
    sql,
    identity.organisationId,
    identity.streamId,
    base.sequence,
    contract.lastEventSequence,
  );
  if (tail === null) return corruptSession();
  const restored = validateCanonicalSessionRestore({
    snapshot: { lastSequence: base.sequence, state: base.lifecycle },
    tail,
    state: lifecycle,
  });
  if (!restored.ok) return corruptSession();
  if (persistence !== undefined) {
    const last = readOneJournalEvent(
      sql,
      identity.streamId,
      contract.lastEventSequence,
    );
    if (last !== null) {
      VERIFIED_SESSION_POINTS.set(persistence, {
        organisationId: identity.organisationId,
        streamId: identity.streamId,
        sequence: contract.lastEventSequence,
        eventId: last.event_id,
        projection: row.value.projection,
      });
    }
  }
  return session;
}

/**
 * Verify the stored state against the journal events after a verified point.
 * The new point when the replay from the point gives the stored state. Null
 * when the point does not apply or the replay does not give that state: the
 * caller then replays the whole journal.
 */
function verifyFromSessionPoint(
  sql: SqlStorage,
  point: VerifiedSessionPoint,
  lifecycle: ImportedCanonicalSessionLifecycle,
  projection: string,
): VerifiedSessionPoint | null {
  const { identity, contract } = lifecycle.state;
  const through = contract.lastEventSequence;
  if (
    point.organisationId !== identity.organisationId ||
    point.streamId !== identity.streamId ||
    point.sequence > through
  )
    return null;
  const rows = sql
    .exec<CanonicalJournalRow>(
      `SELECT organisation_id, stream_id, sequence, event_id, envelope
       FROM actor_journal
       WHERE stream_id = ? AND sequence >= ? AND sequence <= ?
       ORDER BY sequence`,
      identity.streamId,
      point.sequence,
      through,
    )
    .toArray();
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (
    rows.length !== through - point.sequence + 1 ||
    first === undefined ||
    last === undefined ||
    first.organisation_id !== identity.organisationId ||
    first.stream_id !== identity.streamId ||
    first.sequence !== point.sequence ||
    first.event_id !== point.eventId
  )
    return null;
  // No event follows the point. The state is the one that was verified.
  if (through === point.sequence)
    return projection === point.projection ? point : null;
  const verified = parseImportedCanonicalLifecycle(point.projection);
  if (!verified.ok) return null;
  const tail: { sequence: number; transition: unknown }[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const sequence = point.sequence + index;
    if (
      row === undefined ||
      row.organisation_id !== identity.organisationId ||
      row.stream_id !== identity.streamId ||
      row.sequence !== sequence
    )
      return null;
    const transition = parseJournalTransition(
      row.envelope,
      identity.organisationId,
      identity.streamId,
      sequence,
    );
    if (transition === null) return null;
    tail.push({ sequence, transition });
  }
  const restored = validateCanonicalSessionRestore({
    snapshot: { lastSequence: point.sequence, state: verified.value },
    tail,
    state: lifecycle,
  });
  return restored.ok
    ? {
        organisationId: point.organisationId,
        streamId: point.streamId,
        sequence: through,
        eventId: last.event_id,
        projection,
      }
    : null;
}

export function readCanonicalSessionForPersistence(
  persistence: AgentSessionPersistence,
  sql: SqlStorage,
  requestingOrganisationId: string,
): Promise<
  Result<ImportedCanonicalSessionRecord, CanonicalSessionAccessError>
> {
  return readVerifiedImportedCanonicalSession(
    sql,
    requestingOrganisationId,
    persistence,
  );
}

export function parseImportedCanonicalLifecycle(
  encoded: string,
): Result<ImportedCanonicalSessionLifecycle, CanonicalSessionReadError> {
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    return corruptSession();
  }
  if (!isRecord(raw) || !isRecord(raw.state)) return corruptSession();
  const identity = parseIdentity(raw.state.identity);
  const contract = parseContract(raw.state.contract);
  if (identity === null || contract === null) return corruptSession();
  switch (raw.kind) {
    case "sleeping": {
      const resumePoint = parseResumePoint(raw.state.resumePoint);
      return resumePoint === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "sleeping",
              state: { identity, contract, resumePoint },
            },
          };
    }
    case "activating": {
      const turnId = nonEmptyString(raw.state.turnId);
      const inputId = nonEmptyString(raw.state.inputId);
      const resumePoint = parseResumePoint(raw.state.resumePoint);
      const runtimeGeneration = positiveIntegerOrNull(
        raw.state.runtimeGeneration,
      );
      return turnId === null ||
        inputId === null ||
        resumePoint === null ||
        runtimeGeneration === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "activating",
              state: {
                identity,
                contract,
                turnId,
                inputId,
                resumePoint,
                runtimeGeneration,
              },
            },
          };
    }
    case "processing": {
      const resumePoint = parseResumePoint(raw.state.resumePoint);
      const runtimeLease = parseRuntimeLease(raw.state.runtimeLease);
      const activeTurn = parseProcessingTurn(raw.state.activeTurn);
      return resumePoint === null ||
        runtimeLease === null ||
        activeTurn === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "processing",
              state: {
                identity,
                contract,
                resumePoint,
                runtimeLease,
                activeTurn,
              },
            },
          };
    }
    case "recovering": {
      if (
        !hasExactKeys(raw.state, [
          "identity",
          "contract",
          "resumePoint",
          "fencedRuntime",
          "activeTurn",
          "continuation",
          "action",
        ])
      )
        return corruptSession();
      const resumePoint = parseResumePoint(raw.state.resumePoint);
      const fencedRuntime = parseRuntimeLease(raw.state.fencedRuntime);
      const activeTurn = parseProcessingTurn(raw.state.activeTurn);
      const continuation = parseTaskContinuation(raw.state.continuation);
      const action = parseRecoveryAction(raw.state.action);
      if (
        resumePoint === null ||
        fencedRuntime === null ||
        activeTurn === null ||
        continuation === null ||
        action === null
      )
        return corruptSession();
      return {
        ok: true,
        value: {
          kind: "recovering",
          state: {
            identity,
            contract,
            resumePoint,
            fencedRuntime,
            activeTurn,
            continuation,
            action,
          },
        },
      };
    }
    case "checkpointing": {
      const runtimeLease = parseRuntimeLease(raw.state.runtimeLease);
      const turnId = nonEmptyString(raw.state.turnId);
      const inputId = nonEmptyString(raw.state.inputId);
      const turnLeaseGeneration = positiveIntegerOrNull(
        raw.state.turnLeaseGeneration,
      );
      const outcome = parseTurnOutcome(raw.state.outcome);
      const resumePoint = parseResumePoint(raw.state.resumePoint);
      const workspaceRevisionReceipt = parseWorkspaceReceipt(
        raw.state.workspaceRevisionReceipt,
      );
      return runtimeLease === null ||
        turnId === null ||
        inputId === null ||
        turnLeaseGeneration === null ||
        outcome === null ||
        resumePoint === null ||
        workspaceRevisionReceipt === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "checkpointing",
              state: {
                identity,
                contract,
                runtimeLease,
                turnId,
                inputId,
                turnLeaseGeneration,
                outcome,
                resumePoint,
                workspaceRevisionReceipt,
              },
            },
          };
    }
    case "quarantined": {
      const reason = parseQuarantineReason(raw.state.reason);
      const recovery = parseQuarantineRecovery(raw.state.recovery);
      return reason === null || recovery === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "quarantined",
              state: { identity, contract, reason, recovery },
            },
          };
    }
    case "terminal": {
      const reason = parseTerminalReason(raw.state.reason);
      const terminalAt = nonNegativeIntegerValue(raw.state.terminalAt);
      return reason === null || terminalAt === null
        ? corruptSession()
        : {
            ok: true,
            value: {
              kind: "terminal",
              state: { identity, contract, reason, terminalAt },
            },
          };
    }
    case "cancelling": {
      const plan = parseCancellationPlan(raw.state.plan);
      return plan === null
        ? corruptSession()
        : {
            ok: true,
            value: { kind: "cancelling", state: { identity, contract, plan } },
          };
    }
    default:
      return corruptSession();
  }
}

function parseTurnOutcome(
  raw: unknown,
): Variant<AgentSessionLifecycle, "checkpointing">["state"]["outcome"] | null {
  return raw === "completed" || raw === "cancelled" || raw === "failed"
    ? raw
    : null;
}

function parseTaskContinuation(raw: unknown): HarnessTaskContinuation | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "pi" ||
    !hasExactKeys(raw, [
      "kind",
      "harnessTaskId",
      "submissionId",
      "harnessBuild",
      "historyCursor",
    ])
  )
    return null;
  const harnessTaskId = nonEmptyString(raw.harnessTaskId);
  const submissionId = nonEmptyString(raw.submissionId);
  const harnessBuild = nonEmptyString(raw.harnessBuild);
  if (
    harnessTaskId === null ||
    submissionId === null ||
    harnessBuild === null ||
    !isRecord(raw.historyCursor) ||
    !hasExactKeys(raw.historyCursor, ["lastSequence", "lastEntryDigest"])
  )
    return null;
  const lastSequence = positiveIntegerOrNull(raw.historyCursor.lastSequence);
  const lastEntryDigest = raw.historyCursor.lastEntryDigest;
  if (
    lastSequence === null ||
    typeof lastEntryDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(lastEntryDigest)
  )
    return null;
  return {
    kind: "pi",
    harnessTaskId,
    submissionId,
    harnessBuild,
    historyCursor: { lastSequence, lastEntryDigest },
  };
}

function parseRecoveryAction(raw: unknown): SessionRecoveryAction | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "resume_task":
      return hasExactKeys(raw, ["kind"]) ? { kind: "resume_task" } : null;
    case "retry_at": {
      const retryAt = nonNegativeIntegerValue(raw.retryAt);
      return hasExactKeys(raw, ["kind", "retryAt"]) && retryAt !== null
        ? { kind: "retry_at", retryAt }
        : null;
    }
    case "await_evidence": {
      const evidence = parseRecoveryEvidence(raw.evidence);
      return hasExactKeys(raw, ["kind", "evidence"]) && evidence !== null
        ? { kind: "await_evidence", evidence }
        : null;
    }
    case "blocked":
      if (!hasExactKeys(raw, ["kind", "reason"])) return null;
      switch (raw.reason) {
        case "authorization":
        case "budget":
        case "implementation":
        case "retry_exhausted":
          return { kind: "blocked", reason: raw.reason };
        default:
          return null;
      }
    default:
      return null;
  }
}

function parseRecoveryEvidence(raw: unknown): SessionRecoveryEvidence | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "model_usage": {
      if (
        !hasExactKeys(raw, ["kind", "modelRequestId", "runId", "reservationId"])
      )
        return null;
      const modelRequestId = nonEmptyString(raw.modelRequestId);
      const runId = nonEmptyString(raw.runId);
      const reservationId = nonEmptyString(raw.reservationId);
      return modelRequestId === null || runId === null || reservationId === null
        ? null
        : { kind: "model_usage", modelRequestId, runId, reservationId };
    }
    case "effect_receipt": {
      const effectId = nonEmptyString(raw.effectId);
      return hasExactKeys(raw, ["kind", "effectId"]) && effectId !== null
        ? { kind: "effect_receipt", effectId }
        : null;
    }
    default:
      return null;
  }
}

function parseRuntimeLease(
  raw: unknown,
): { generation: number; leaseId: string } | null {
  if (!isRecord(raw)) return null;
  const generation = positiveIntegerOrNull(raw.generation);
  const leaseId = nonEmptyString(raw.leaseId);
  return generation === null || leaseId === null
    ? null
    : { generation, leaseId };
}

function parseProcessingTurn(raw: unknown): ImportedProcessingTurn | null {
  if (!isRecord(raw) || !isRecord(raw.state)) return null;
  const identity = parseTurnIdentity(raw.state.identity);
  if (identity === null) return null;
  if (raw.kind === "reducing_result") {
    const receiptId = nonEmptyString(raw.state.receiptId);
    const workspaceRevisionReceipt = parseWorkspaceReceipt(
      raw.state.workspaceRevisionReceipt,
    );
    return receiptId === null || workspaceRevisionReceipt === null
      ? null
      : {
          kind: "reducing_result",
          state: { identity, receiptId, workspaceRevisionReceipt },
        };
  }
  if (raw.kind === "awaiting_execution") {
    const executionId = nonEmptyString(raw.state.executionId);
    const effectId = nonEmptyString(raw.state.effectId);
    return executionId === null || effectId === null
      ? null
      : {
          kind: "awaiting_execution",
          state: { identity, executionId, effectId },
        };
  }
  if (raw.kind !== "admitted") return null;
  const admittedAt = nonNegativeIntegerValue(raw.state.admittedAt);
  return admittedAt === null
    ? null
    : { kind: "admitted", state: { identity, admittedAt } };
}

function parseTurnIdentity(raw: unknown): ImportedTurnIdentity | null {
  if (!isRecord(raw)) return null;
  const turnId = nonEmptyString(raw.turnId);
  const inputId = nonEmptyString(raw.inputId);
  const turnLeaseGeneration = positiveIntegerOrNull(raw.turnLeaseGeneration);
  const budgetRevision = nonEmptyString(raw.budgetRevision);
  return turnId === null ||
    inputId === null ||
    turnLeaseGeneration === null ||
    budgetRevision === null
    ? null
    : { turnId, inputId, turnLeaseGeneration, budgetRevision };
}

function hasCanonicalSchema(sql: SqlStorage): boolean {
  const rows = sql
    .exec<{ value: number }>(
      `SELECT value
       FROM do_schema_meta
       WHERE key = 'session_hot_schema'
       LIMIT 2`,
    )
    .toArray();
  return (
    rows.length === 1 && rows[0]?.value === CANONICAL_SESSION_SCHEMA_VERSION
  );
}

function hasCanonicalActivation(
  sql: SqlStorage,
  identity: SessionIdentity,
): boolean {
  const rows = sql
    .exec<CanonicalActivationRow>(
      `SELECT organisation_id, object_kind, logical_object_id, schema_version
       FROM state_object_activation
       WHERE singleton = 1
       LIMIT 2`,
    )
    .toArray();
  const row = rows[0];
  return (
    rows.length === 1 &&
    row !== undefined &&
    row.organisation_id === identity.organisationId &&
    row.object_kind === "session" &&
    row.logical_object_id === identity.sessionId &&
    row.schema_version === CANONICAL_SESSION_SCHEMA_VERSION
  );
}

function readLatestSnapshot(
  sql: SqlStorage,
  streamId: string,
  lastSequence: number,
): CanonicalSnapshotRow | null {
  const rows = sql
    .exec<CanonicalSnapshotRow>(
      `SELECT organisation_id, stream_id, last_sequence, reducer_schema_version,
              state_digest, state_projection
       FROM actor_snapshot
       WHERE stream_id = ? AND last_sequence <= ?
       ORDER BY last_sequence DESC
       LIMIT 2`,
      streamId,
      lastSequence,
    )
    .toArray();
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function snapshotMatchesIdentity(
  snapshot: CanonicalSnapshotRow,
  lifecycle: ImportedCanonicalSessionLifecycle,
): boolean {
  const projected = parseImportedCanonicalLifecycle(snapshot.state_projection);
  return (
    projected.ok &&
    snapshot.organisation_id === lifecycle.state.identity.organisationId &&
    snapshot.stream_id === lifecycle.state.identity.streamId &&
    snapshot.last_sequence ===
      projected.value.state.contract.lastEventSequence &&
    snapshot.last_sequence <= lifecycle.state.contract.lastEventSequence &&
    Number.isSafeInteger(snapshot.reducer_schema_version) &&
    snapshot.reducer_schema_version >= 1 &&
    projected.value.state.identity.organisationId ===
      lifecycle.state.identity.organisationId &&
    projected.value.state.identity.sessionId ===
      lifecycle.state.identity.sessionId &&
    projected.value.state.identity.streamId ===
      lifecycle.state.identity.streamId
  );
}

function readJournalTail(
  sql: SqlStorage,
  organisationId: string,
  streamId: string,
  afterSequence: number,
  throughSequence: number,
): readonly { sequence: number; transition: unknown }[] | null {
  const rows = sql
    .exec<CanonicalJournalRow>(
      `SELECT organisation_id, stream_id, sequence, event_id, envelope
       FROM actor_journal
       WHERE stream_id = ? AND sequence > ? AND sequence <= ?
       ORDER BY sequence`,
      streamId,
      afterSequence,
      throughSequence,
    )
    .toArray();
  if (rows.length !== throughSequence - afterSequence) return null;
  const tail: { sequence: number; transition: unknown }[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedSequence = afterSequence + index + 1;
    if (
      row === undefined ||
      row.organisation_id !== organisationId ||
      row.stream_id !== streamId ||
      row.sequence !== expectedSequence
    ) {
      return null;
    }
    const transition = parseJournalTransition(
      row.envelope,
      organisationId,
      streamId,
      expectedSequence,
    );
    if (transition === null) return null;
    tail.push({ sequence: expectedSequence, transition });
  }
  return tail;
}

function parseJournalTransition(
  encoded: string,
  organisationId: string,
  streamId: string,
  sequence: number,
): unknown | null {
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    raw.envelopeVersion !== "actor-envelope.v1" ||
    raw.payloadVersion !== "session-transition.v1" ||
    raw.organisationId !== organisationId ||
    raw.streamId !== streamId ||
    raw.sequence !== sequence ||
    !isRecord(raw.body)
  ) {
    return null;
  }
  return raw.body;
}

function readOneJournalEvent(
  sql: SqlStorage,
  streamId: string,
  sequence: number,
): CanonicalJournalRow | null {
  const rows = sql
    .exec<CanonicalJournalRow>(
      `SELECT organisation_id, stream_id, sequence, event_id, envelope
       FROM actor_journal
       WHERE stream_id = ? AND sequence = ?
       LIMIT 2`,
      streamId,
      sequence,
    )
    .toArray();
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

type ImportedJournalEvidence = {
  eventId: string;
  idempotencyKey: string;
  operationId: string;
  sequence: number;
  source: "migration" | "surface_actor" | "case_actor";
};

type VerifiedCanonicalBase = {
  readonly sequence: number;
  readonly lifecycle: ImportedCanonicalSessionLifecycle;
  readonly journal: CanonicalJournalRow;
  readonly event: ImportedJournalEvidence;
};

async function readVerifiedCanonicalBase(
  sql: SqlStorage,
  streamId: string,
  lastSequence: number,
  lifecycle: ImportedCanonicalSessionLifecycle,
): Promise<VerifiedCanonicalBase | null> {
  const snapshot = readLatestSnapshot(sql, streamId, lastSequence);
  if (snapshot !== null) {
    if (!snapshotMatchesIdentity(snapshot, lifecycle)) return null;
    const snapshotDigest = await sha256Hex(snapshot.state_projection);
    if (snapshot.state_digest !== snapshotDigest) return null;
    const parsed = parseImportedCanonicalLifecycle(snapshot.state_projection);
    if (!parsed.ok) return null;
    const journal = readOneJournalEvent(sql, streamId, snapshot.last_sequence);
    const event =
      journal === null
        ? null
        : parseImportedJournalEvent(journal.envelope, parsed.value);
    return journal === null || event === null
      ? null
      : {
          sequence: snapshot.last_sequence,
          lifecycle: parsed.value,
          journal,
          event,
        };
  }

  const journal = readOneJournalEvent(sql, streamId, 0);
  const initialized =
    journal === null
      ? null
      : parseInitializedJournalEvent(sql, journal.envelope);
  return journal === null || initialized === null
    ? null
    : {
        sequence: 0,
        lifecycle: initialized.lifecycle,
        journal,
        event: initialized.event,
      };
}

function parseImportedJournalEvent(
  encoded: string,
  lifecycle: ImportedCanonicalSessionLifecycle,
): ImportedJournalEvidence | null {
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.body) || !isRecord(raw.causation))
    return null;
  const eventId = nonEmptyString(raw.eventId);
  const organisationId = nonEmptyString(raw.organisationId);
  const actorId = nonEmptyString(raw.actorId);
  const streamId = nonEmptyString(raw.streamId);
  const idempotencyKey = nonEmptyString(raw.idempotencyKey);
  const runtimeRevision = nonEmptyString(raw.runtimeRevision);
  const migrationId = nonEmptyString(raw.causation.migrationId);
  const sequence = nonNegativeIntegerValue(raw.sequence);
  const encodedImportedState = JSON.stringify(raw.body.state);
  if (encodedImportedState === undefined) return null;
  const importedState = parseImportedCanonicalLifecycle(encodedImportedState);
  if (
    raw.envelopeVersion !== "actor-envelope.v1" ||
    raw.payloadVersion !== "session-transition.v1" ||
    raw.body.kind !== "session_state_imported" ||
    raw.causation.kind !== "migration" ||
    eventId === null ||
    organisationId !== lifecycle.state.identity.organisationId ||
    actorId !== lifecycle.state.identity.sessionId ||
    streamId !== lifecycle.state.identity.streamId ||
    idempotencyKey === null ||
    runtimeRevision !== lifecycle.state.contract.runtimeRevision ||
    migrationId === null ||
    sequence !== lifecycle.state.contract.lastEventSequence ||
    sequence !== 0 ||
    !importedState.ok ||
    !sameLifecycle(importedState.value, lifecycle)
  ) {
    return null;
  }
  return {
    eventId,
    idempotencyKey,
    operationId: migrationId,
    sequence,
    source: "migration",
  };
}

function parseInitializedJournalEvent(
  sql: SqlStorage,
  encoded: string,
): {
  readonly lifecycle: ImportedCanonicalSessionLifecycle;
  readonly event: ImportedJournalEvidence;
} | null {
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.body) || !isRecord(raw.causation))
    return null;
  const eventId = nonEmptyString(raw.eventId);
  const organisationId = nonEmptyString(raw.organisationId);
  const actorId = nonEmptyString(raw.actorId);
  const streamId = nonEmptyString(raw.streamId);
  const idempotencyKey = nonEmptyString(raw.idempotencyKey);
  const runtimeRevision = nonEmptyString(raw.runtimeRevision);
  const commandId = nonEmptyString(raw.causation.commandId);
  const sequence = nonNegativeIntegerValue(raw.sequence);
  const lifecycle = parseImportedCanonicalLifecycle(
    JSON.stringify({ kind: "sleeping", state: raw.body.state }),
  );
  if (
    raw.envelopeVersion !== "actor-envelope.v1" ||
    raw.payloadVersion !== "session-transition.v1" ||
    raw.body.kind !== "session_initialized" ||
    raw.causation.kind !== "command" ||
    eventId === null ||
    organisationId === null ||
    actorId === null ||
    streamId === null ||
    idempotencyKey === null ||
    runtimeRevision === null ||
    commandId === null ||
    sequence !== 0 ||
    !lifecycle.ok ||
    lifecycle.value.state.identity.organisationId !== organisationId ||
    lifecycle.value.state.identity.sessionId !== actorId ||
    lifecycle.value.state.identity.streamId !== streamId ||
    lifecycle.value.state.contract.runtimeRevision !== runtimeRevision
  ) {
    return null;
  }
  const base = {
    lifecycle: lifecycle.value,
    event: {
      eventId,
      idempotencyKey,
      operationId: commandId,
      sequence,
    },
  };
  const surfaceEvent: ImportedJournalEvidence = {
    ...base.event,
    source: "surface_actor",
  };
  const surfaceInbox = readOneAcceptance(
    sql,
    surfaceEvent.source,
    surfaceEvent.idempotencyKey,
  );
  if (
    surfaceInbox !== null &&
    inboxMatchesEvent(surfaceInbox, organisationId, surfaceEvent)
  ) {
    return { lifecycle: base.lifecycle, event: surfaceEvent };
  }
  const caseEvent: ImportedJournalEvidence = {
    ...base.event,
    source: "case_actor",
  };
  const caseInbox = readOneAcceptance(
    sql,
    caseEvent.source,
    caseEvent.idempotencyKey,
  );
  return caseInbox !== null &&
    inboxMatchesEvent(caseInbox, organisationId, caseEvent)
    ? { lifecycle: base.lifecycle, event: caseEvent }
    : null;
}

function readOneAcceptance(
  sql: SqlStorage,
  source: ImportedJournalEvidence["source"],
  idempotencyKey: string,
): CanonicalInboxRow | null {
  const rows = sql
    .exec<CanonicalInboxRow>(
      `SELECT organisation_id, source, idempotency_key, operation_id, outcome
       FROM actor_inbox
       WHERE source = ? AND idempotency_key = ?
       LIMIT 2`,
      source,
      idempotencyKey,
    )
    .toArray();
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function inboxMatchesEvent(
  inbox: CanonicalInboxRow,
  organisationId: string,
  event: ImportedJournalEvidence,
): boolean {
  let outcome: unknown;
  try {
    outcome = JSON.parse(inbox.outcome);
  } catch {
    return false;
  }
  return (
    inbox.organisation_id === organisationId &&
    inbox.source === event.source &&
    inbox.idempotency_key === event.idempotencyKey &&
    inbox.operation_id === event.operationId &&
    isRecord(outcome) &&
    outcome.kind === "accepted" &&
    outcome.eventId === event.eventId &&
    outcome.sequence === event.sequence
  );
}

function sameLifecycle(
  left: ImportedCanonicalSessionLifecycle,
  right: ImportedCanonicalSessionLifecycle,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rowMatchesLifecycle(
  row: CanonicalSessionRow,
  lifecycle: ImportedCanonicalSessionLifecycle,
): boolean {
  const state = lifecycle.state;
  if (
    row.lifecycle_kind !== lifecycle.kind ||
    row.organisation_id !== state.identity.organisationId ||
    row.session_id !== state.identity.sessionId ||
    row.last_event_sequence !== state.contract.lastEventSequence ||
    row.policy_version !== state.contract.policyVersion
  ) {
    return false;
  }
  return lifecycle.kind === "terminal"
    ? row.terminal_at === lifecycle.state.terminalAt
    : row.terminal_at === null;
}

function parseIdentity(raw: unknown): SessionIdentity | null {
  if (!isRecord(raw)) return null;
  const organisationId = nonEmptyString(raw.organisationId);
  const sessionId = nonEmptyString(raw.sessionId);
  const streamId = nonEmptyString(raw.streamId);
  return organisationId === null || sessionId === null || streamId === null
    ? null
    : { organisationId, sessionId, streamId };
}

function parseContract(raw: unknown): SessionContract | null {
  if (!isRecord(raw)) return null;
  const policyVersion = nonEmptyString(raw.policyVersion);
  const budgetRevision = nonEmptyString(raw.budgetRevision);
  const runtimeRevision = nonEmptyString(raw.runtimeRevision);
  const modelRoute = parseSessionModelRoute(raw.modelRoute);
  const lastEventSequence = nonNegativeIntegerValue(raw.lastEventSequence);
  return policyVersion === null ||
    budgetRevision === null ||
    runtimeRevision === null ||
    !modelRoute.ok ||
    lastEventSequence === null
    ? null
    : {
        policyVersion,
        budgetRevision,
        runtimeRevision,
        modelRoute: modelRoute.value,
        lastEventSequence,
      };
}

function parseResumePoint(
  raw: unknown,
): Variant<AgentSessionLifecycle, "sleeping">["state"]["resumePoint"] | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "new") {
    const workspaceRevisionReceipt = parseWorkspaceReceipt(
      raw.workspaceRevisionReceipt,
    );
    return workspaceRevisionReceipt === null
      ? null
      : { kind: "new", workspaceRevisionReceipt };
  }
  if (raw.kind !== "checkpoint") return null;
  const checkpoint = parseCheckpoint(raw.checkpoint);
  return checkpoint === null ? null : { kind: "checkpoint", checkpoint };
}

function parseCheckpoint(raw: unknown): VerifiedSessionCheckpoint | null {
  if (!isRecord(raw)) return null;
  const checkpointId = nonEmptyString(raw.checkpointId);
  const stateDigest = sha256Digest(raw.stateDigest);
  const lastEventSequence = nonNegativeIntegerValue(raw.lastEventSequence);
  const runtimeRevision = nonEmptyString(raw.runtimeRevision);
  const runtimeGeneration = positiveIntegerOrNull(raw.runtimeGeneration);
  const policyVersion = nonEmptyString(raw.policyVersion);
  const budgetRevision = nonEmptyString(raw.budgetRevision);
  const budgetUsage = parseSessionBudgetUsage(raw.budgetUsage);
  const usageCursor = nonNegativeIntegerValue(raw.usageCursor);
  const budgetAccountDigest = sha256Digest(raw.budgetAccountDigest);
  const workspaceRevisionReceipt = parseWorkspaceReceipt(
    raw.workspaceRevisionReceipt,
  );
  return checkpointId === null ||
    stateDigest === null ||
    lastEventSequence === null ||
    runtimeRevision === null ||
    runtimeGeneration === null ||
    policyVersion === null ||
    budgetRevision === null ||
    budgetUsage === null ||
    usageCursor === null ||
    budgetAccountDigest === null ||
    workspaceRevisionReceipt === null
    ? null
    : {
        checkpointId,
        stateDigest,
        lastEventSequence,
        runtimeRevision,
        runtimeGeneration,
        policyVersion,
        budgetRevision,
        budgetUsage,
        usageCursor,
        budgetAccountDigest,
        workspaceRevisionReceipt,
      };
}

function parseSessionBudgetUsage(raw: unknown): SessionBudgetUsage | null {
  if (!isRecord(raw)) return null;
  const tokens = nonNegativeIntegerValue(raw.tokens);
  const activeWallMs = nonNegativeIntegerValue(raw.activeWallMs);
  const capabilityCalls = nonNegativeIntegerValue(raw.capabilityCalls);
  return tokens === null || activeWallMs === null || capabilityCalls === null
    ? null
    : { tokens, activeWallMs, capabilityCalls };
}

function parseQuarantineReason(
  raw: unknown,
): Variant<AgentSessionLifecycle, "quarantined">["state"]["reason"] | null {
  return raw === "integrity_failure" ||
    raw === "activation_failure" ||
    raw === "replay_failure" ||
    raw === "effect_indeterminate" ||
    raw === "journal_budget_exceeded" ||
    raw === "migration_blocked"
    ? raw
    : null;
}

function parseQuarantineRecovery(
  raw: unknown,
): Variant<AgentSessionLifecycle, "quarantined">["state"]["recovery"] | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "terminate_only") return { kind: "terminate_only" };
  if (raw.kind !== "reactivate") return null;
  const turnId = nonEmptyString(raw.turnId);
  const inputId = nonEmptyString(raw.inputId);
  const resumePoint = parseResumePoint(raw.resumePoint);
  const nextRuntimeGeneration = positiveIntegerOrNull(
    raw.nextRuntimeGeneration,
  );
  return turnId === null ||
    inputId === null ||
    resumePoint === null ||
    nextRuntimeGeneration === null
    ? null
    : {
        kind: "reactivate",
        turnId,
        inputId,
        resumePoint,
        nextRuntimeGeneration,
      };
}

function parseTerminalReason(
  raw: unknown,
): Variant<AgentSessionLifecycle, "terminal">["state"]["reason"] | null {
  return raw === "closed" ||
    raw === "expired" ||
    raw === "erased" ||
    raw === "cancelled" ||
    raw === "failed"
    ? raw
    : null;
}

function parseCancellationPlan(
  raw: unknown,
): Variant<AgentSessionLifecycle, "cancelling">["state"]["plan"] | null {
  if (!isRecord(raw)) return null;
  const lease = parseCancellationLease(raw.lease);
  if (lease === null) return null;
  if (raw.kind === "session") {
    const reason = parseTerminalReason(raw.reason);
    return reason === null ? null : { kind: "session", reason, lease };
  }
  if (raw.kind !== "turn") return null;
  const turnId = nonEmptyString(raw.turnId);
  const inputId = nonEmptyString(raw.inputId);
  const resumePoint = parseResumePoint(raw.resumePoint);
  return turnId === null || inputId === null || resumePoint === null
    ? null
    : { kind: "turn", turnId, inputId, resumePoint, lease };
}

function parseCancellationLease(
  raw: unknown,
):
  | Variant<AgentSessionLifecycle, "cancelling">["state"]["plan"]["lease"]
  | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind !== "active") return null;
  const runtimeLease = parseRuntimeLease(raw.runtimeLease);
  const turnLeaseGeneration = positiveIntegerOrNull(raw.turnLeaseGeneration);
  return runtimeLease === null || turnLeaseGeneration === null
    ? null
    : { kind: "active", runtimeLease, turnLeaseGeneration };
}

function corruptSession(): Result<never, CanonicalSessionReadError> {
  return { ok: false, error: { code: "canonical_session_corrupt" } };
}

function validTrack(
  raw: string,
): raw is ImportedCanonicalSessionRecord["track"] {
  return raw === "managed-agents" || raw === "byo";
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw === raw.trim()
    ? raw
    : null;
}

function nonNegativeIntegerValue(raw: unknown): number | null {
  return typeof raw === "number" && isNonNegativeInteger(raw) ? raw : null;
}

function sha256Digest(raw: unknown): string | null {
  return typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}
