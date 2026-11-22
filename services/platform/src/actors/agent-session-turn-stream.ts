import type {
  AgentEvent,
  AgentEventEnvelope,
  ArtifactRef,
  ErrorSource,
  Outcome,
} from "@purin-labs/contracts";
import {
  parseRequestId,
  parseOrganisationId,
  type RequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseSessionTurnInputDigest,
  type SessionTurnInputDigest,
} from "./agent-session-turn-input-digest";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";

type SessionTurnStreamState =
  | {
      kind: "running";
      turnId: string;
      requestId: RequestId;
      organisationId: OrganisationId;
      inputDigest: SessionTurnInputDigest | null;
      revision: number;
      lastSequence: number;
      errorDetail: null;
      startedAt: number;
      updatedAt: number;
    }
  | {
      kind: "complete";
      turnId: string;
      requestId: RequestId;
      organisationId: OrganisationId;
      inputDigest: SessionTurnInputDigest | null;
      revision: number;
      lastSequence: number;
      errorDetail: null;
      startedAt: number;
      updatedAt: number;
    }
  | {
      kind: "failed";
      turnId: string;
      requestId: RequestId;
      organisationId: OrganisationId;
      inputDigest: SessionTurnInputDigest | null;
      revision: number;
      lastSequence: number;
      errorDetail: string;
      startedAt: number;
      updatedAt: number;
    };

type SessionTurnReplay = {
  state: SessionTurnStreamState;
  envelopes: readonly AgentEventEnvelope[];
  caughtUp: boolean;
};

export type SessionTurnStreamRecord =
  | { kind: "upstream_revision"; turnId: string; revision: number }
  | { kind: "event"; envelope: AgentEventEnvelope }
  | { kind: "complete"; turnId: string; lastSequence: number }
  | { kind: "failed"; turnId: string; lastSequence: number; detail: string };

export type SessionTurnStreamError =
  | { code: "invalid_persisted_state" }
  | { code: "session_turn_not_found" }
  | { code: "stream_cursor_invalid" };

type SessionTurnStreamRow = Record<string, SqlStorageValue> & {
  turn_id: string;
  request_id: string;
  organisation_id: string;
  input_digest: string;
  state: "running" | "complete" | "failed";
  last_sequence: number;
  error_detail: string | null;
  started_at: number;
  updated_at: number;
};

type SessionTurnEventRow = Record<string, SqlStorageValue> & {
  turn_id: string;
  request_id: string;
  organisation_id: string;
  turn_sequence: number;
  payload: string;
  at: number;
};

const SESSION_TURN_REPLAY_PAGE_SIZE = 256;

/**
 * Readers of a turn's replay that wait for its next change. A Session writes
 * its stream and serves its replay in one object, so a write wakes the reader
 * directly. Each storage instance owns its readers, so a replaced Session
 * cannot wake promises owned by the retired instance. A reader still polls:
 * the signal is lost when the object restarts, and a rolled-back write can
 * wake a reader for nothing.
 */
const turnStreamReaders = new WeakMap<
  SqlStorage,
  Map<string, Set<() => void>>
>();

/** Resolves at the next write to the turn's stream, or after `timeoutMs`. */
export function waitForSessionTurnStreamChange(
  sql: SqlStorage,
  turnId: string,
  timeoutMs: number,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const streams = turnStreamReaders.get(sql) ?? new Map();
  turnStreamReaders.set(sql, streams);
  const readers = streams.get(turnId) ?? new Set();
  streams.set(turnId, readers);
  const wake = wakeSessionTurnStreamReader.bind(null, streams, turnId, resolve);
  readers.add(resolve);
  void scheduler.wait(timeoutMs).then(wake);
  return promise;
}

function wakeSessionTurnStreamReader(
  streams: Map<string, Set<() => void>>,
  turnId: string,
  resolve: () => void,
): void {
  const readers = streams.get(turnId);
  if (readers !== undefined) {
    readers.delete(resolve);
    if (readers.size === 0) streams.delete(turnId);
  }
  resolve();
}

function signalSessionTurnStream(sql: SqlStorage, turnId: string): void {
  const streams = turnStreamReaders.get(sql);
  if (streams === undefined) return;
  const readers = streams.get(turnId);
  if (readers === undefined) return;
  for (const resolve of [...readers])
    wakeSessionTurnStreamReader(streams, turnId, resolve);
}

export function beginSessionTurnStream(
  sql: SqlStorage,
  input: {
    turnId: string;
    requestId: RequestId;
    organisationId: OrganisationId;
    inputDigest: SessionTurnInputDigest;
    startedAt: number;
  },
): Result<"started" | "existing", SessionTurnStreamError> {
  const existing = readSessionTurnStream(sql, input.turnId);

  if (existing.ok) {
    return existing.value.requestId === input.requestId &&
      existing.value.organisationId === input.organisationId &&
      existing.value.inputDigest === input.inputDigest
      ? { ok: true, value: "existing" }
      : { ok: false, error: { code: "invalid_persisted_state" } };
  }

  if (existing.error.code !== "session_turn_not_found") {
    return { ok: false, error: existing.error };
  }

  sql.exec(
    `INSERT INTO session_turn_stream (
       turn_id,
       request_id,
       organisation_id,
       input_digest,
       state,
       last_sequence,
       error_detail,
       started_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, 'running', -1, NULL, ?, ?)`,
    input.turnId,
    input.requestId,
    input.organisationId,
    input.inputDigest,
    input.startedAt,
    input.startedAt,
  );

  return { ok: true, value: "started" };
}

export function advanceSessionTurnStream(
  sql: SqlStorage,
  turnId: string,
  sequence: number,
  updatedAt: number,
): Result<null, SessionTurnStreamError> {
  const state = readSessionTurnStream(sql, turnId);

  if (!state.ok) {
    return { ok: false, error: state.error };
  }

  if (state.value.kind !== "running" || sequence < state.value.lastSequence) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  if (sequence === state.value.lastSequence) {
    return { ok: true, value: null };
  }

  if (sequence !== state.value.lastSequence + 1) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  sql.exec(
    `UPDATE session_turn_stream
     SET last_sequence = ?, updated_at = ?
     WHERE turn_id = ? AND state = 'running'`,
    sequence,
    updatedAt,
    turnId,
  );
  signalSessionTurnStream(sql, turnId);

  return { ok: true, value: null };
}

export function completeSessionTurnStream(
  sql: SqlStorage,
  turnId: string,
  lastSequence: number,
  updatedAt: number,
): Result<null, SessionTurnStreamError> {
  const state = readSessionTurnStream(sql, turnId);

  if (!state.ok) {
    return { ok: false, error: state.error };
  }

  if (
    state.value.kind === "complete" &&
    state.value.lastSequence === lastSequence
  ) {
    return { ok: true, value: null };
  }

  if (
    state.value.kind !== "running" ||
    state.value.lastSequence !== lastSequence ||
    lastSequence < 0
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  sql.exec(
    `UPDATE session_turn_stream
     SET state = 'complete', updated_at = ?
     WHERE turn_id = ? AND state = 'running'`,
    updatedAt,
    turnId,
  );
  signalSessionTurnStream(sql, turnId);

  return { ok: true, value: null };
}

export function failSessionTurnStream(
  sql: SqlStorage,
  turnId: string,
  detail: string,
  updatedAt: number,
): Result<null, SessionTurnStreamError> {
  const state = readSessionTurnStream(sql, turnId);

  if (!state.ok) {
    return { ok: false, error: state.error };
  }

  if (state.value.kind === "complete") {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  if (state.value.kind === "failed") {
    return state.value.errorDetail === detail
      ? { ok: true, value: null }
      : { ok: false, error: { code: "invalid_persisted_state" } };
  }

  sql.exec(
    `UPDATE session_turn_stream
     SET state = 'failed', error_detail = ?, updated_at = ?
     WHERE turn_id = ? AND state = 'running'`,
    detail,
    updatedAt,
    turnId,
  );
  signalSessionTurnStream(sql, turnId);

  return { ok: true, value: null };
}

export function readSessionTurnReplay(
  sql: SqlStorage,
  input: {
    turnId: string;
    organisationId: OrganisationId;
    afterSequence: number;
  },
): Result<SessionTurnReplay, SessionTurnStreamError> {
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < -1) {
    return { ok: false, error: { code: "stream_cursor_invalid" } };
  }

  const state = readSessionTurnStream(sql, input.turnId);

  if (!state.ok) {
    return { ok: false, error: state.error };
  }

  if (
    state.value.organisationId !== input.organisationId ||
    input.afterSequence > state.value.lastSequence
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const rows = sql
    .exec<SessionTurnEventRow>(
      `SELECT turn_id, request_id, organisation_id, turn_sequence, payload, at
       FROM session_event
       WHERE turn_id = ? AND turn_sequence > ?
       ORDER BY turn_sequence ASC
       LIMIT ?`,
      input.turnId,
      input.afterSequence,
      SESSION_TURN_REPLAY_PAGE_SIZE,
    )
    .toArray();
  const envelopes: AgentEventEnvelope[] = [];
  let expected = input.afterSequence + 1;

  for (const row of rows) {
    if (
      row.request_id !== state.value.requestId ||
      row.organisation_id !== state.value.organisationId
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }

    const envelope = parsePersistedEnvelope(row);

    if (!envelope.ok || envelope.value.sequence !== expected) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }

    envelopes.push(envelope.value);
    expected += 1;
  }

  const caughtUp = expected - 1 === state.value.lastSequence;

  if (!caughtUp && rows.length < SESSION_TURN_REPLAY_PAGE_SIZE) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  return { ok: true, value: { state: state.value, envelopes, caughtUp } };
}

export function readSessionTurnStream(
  sql: SqlStorage,
  turnId: string,
): Result<SessionTurnStreamState, SessionTurnStreamError> {
  const row = sql
    .exec<SessionTurnStreamRow>(
      `SELECT
         turn_id,
         request_id,
         organisation_id,
         input_digest,
         state,
         last_sequence,
         error_detail,
         started_at,
         updated_at
       FROM session_turn_stream
       WHERE turn_id = ?
       LIMIT 1`,
      turnId,
    )
    .toArray()[0];

  if (row === undefined) {
    return { ok: false, error: { code: "session_turn_not_found" } };
  }

  if (
    !Number.isSafeInteger(row.last_sequence) ||
    row.last_sequence < -1 ||
    !Number.isSafeInteger(row.started_at) ||
    !Number.isSafeInteger(row.updated_at)
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const requestId = parseRequestId(row.request_id);
  const organisationId = parseOrganisationId(row.organisation_id);
  const inputDigest =
    row.input_digest.length === 0
      ? { ok: true as const, value: null }
      : parseSessionTurnInputDigest(row.input_digest);

  if (!requestId.ok || !organisationId.ok || !inputDigest.ok) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  switch (row.state) {
    case "running":
      return row.error_detail === null
        ? {
            ok: true,
            value: rowToRunningState(
              row,
              requestId.value,
              organisationId.value,
              inputDigest.value,
            ),
          }
        : { ok: false, error: { code: "invalid_persisted_state" } };
    case "complete":
      return row.error_detail === null && row.last_sequence >= 0
        ? {
            ok: true,
            value: rowToCompleteState(
              row,
              requestId.value,
              organisationId.value,
              inputDigest.value,
            ),
          }
        : { ok: false, error: { code: "invalid_persisted_state" } };
    case "failed":
      return row.error_detail !== null && row.error_detail.length > 0
        ? {
            ok: true,
            value: rowToFailedState(
              row,
              requestId.value,
              organisationId.value,
              inputDigest.value,
              row.error_detail,
            ),
          }
        : { ok: false, error: { code: "invalid_persisted_state" } };
    default:
      return { ok: false, error: { code: "invalid_persisted_state" } };
  }
}

export function hasRunningSessionTurn(sql: SqlStorage): boolean {
  return (
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present
       FROM session_turn_stream
       WHERE state = 'running'
       LIMIT 1`,
      )
      .toArray()[0]?.present === 1
  );
}

export function readRunningSessionTurn(
  sql: SqlStorage,
): Result<
  Variant<SessionTurnStreamState, "running"> | null,
  SessionTurnStreamError
> {
  const rows = sql
    .exec<{ turn_id: string }>(
      `SELECT turn_id
       FROM session_turn_stream
       WHERE state = 'running'
       ORDER BY started_at ASC
       LIMIT 2`,
    )
    .toArray();

  if (rows.length === 0) {
    return { ok: true, value: null };
  }

  if (rows.length !== 1) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const row = rows[0];

  if (row === undefined) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const state = readSessionTurnStream(sql, row.turn_id);

  if (!state.ok || state.value.kind !== "running") {
    return state.ok
      ? { ok: false, error: { code: "invalid_persisted_state" } }
      : state;
  }

  return { ok: true, value: state.value };
}

export function parseSessionTurnStreamRecord(
  value: unknown,
): Result<SessionTurnStreamRecord, SessionTurnStreamError> {
  if (!isRecord(value)) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const raw = value;

  if (
    raw.kind === "upstream_revision" &&
    typeof raw.turnId === "string" &&
    Number.isSafeInteger(raw.revision) &&
    Number(raw.revision) >= 1
  ) {
    return {
      ok: true,
      value: {
        kind: "upstream_revision",
        turnId: raw.turnId,
        revision: Number(raw.revision),
      },
    };
  }

  if (raw.kind === "event") {
    const parsed = parseAgentEventEnvelope(raw.envelope);
    return parsed.ok
      ? { ok: true, value: { kind: "event", envelope: parsed.value } }
      : { ok: false, error: { code: "invalid_persisted_state" } };
  }

  if (
    raw.kind === "complete" &&
    typeof raw.turnId === "string" &&
    Number.isSafeInteger(raw.lastSequence) &&
    Number(raw.lastSequence) >= 0
  ) {
    return {
      ok: true,
      value: {
        kind: "complete",
        turnId: raw.turnId,
        lastSequence: Number(raw.lastSequence),
      },
    };
  }

  if (
    raw.kind === "failed" &&
    typeof raw.turnId === "string" &&
    Number.isSafeInteger(raw.lastSequence) &&
    Number(raw.lastSequence) >= -1 &&
    typeof raw.detail === "string" &&
    raw.detail.length > 0
  ) {
    return {
      ok: true,
      value: {
        kind: "failed",
        turnId: raw.turnId,
        lastSequence: Number(raw.lastSequence),
        detail: raw.detail,
      },
    };
  }

  return { ok: false, error: { code: "invalid_persisted_state" } };
}

export function parseAgentEventEnvelope(
  value: unknown,
): Result<AgentEventEnvelope, SessionTurnStreamError> {
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !Number.isSafeInteger(value.emittedAt) ||
    Number(value.emittedAt) < 0
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  const event = parseAgentEvent(value.event);
  return event === null
    ? { ok: false, error: { code: "invalid_persisted_state" } }
    : {
        ok: true,
        value: {
          turnId: value.turnId,
          sequence: Number(value.sequence),
          emittedAt: Number(value.emittedAt),
          event,
        },
      };
}

function parseAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "agent_message":
      return typeof value.text === "string" &&
        typeof value.finalMessage === "boolean"
        ? {
            type: value.type,
            text: value.text,
            finalMessage: value.finalMessage,
          }
        : null;
    case "agent_tool_use":
    case "custom_tool_use":
      return typeof value.tool === "string" &&
        typeof value.callId === "string" &&
        Object.hasOwn(value, "args")
        ? {
            type: value.type,
            tool: value.tool,
            callId: value.callId,
            args: value.args,
          }
        : null;
    case "status":
      return value.state === "starting" ||
        value.state === "running" ||
        value.state === "waiting_input" ||
        value.state === "waiting_approval"
        ? { type: value.type, state: value.state }
        : null;
    case "done": {
      const outcome =
        value.outcome === null ? null : parseOutcome(value.outcome);
      return value.outcome === null || outcome !== null
        ? { type: value.type, outcome }
        : null;
    }
    case "error":
      return isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string" &&
        isErrorSource(value.error.source) &&
        typeof value.retryable === "boolean"
        ? {
            type: value.type,
            error: {
              code: value.error.code,
              message: value.error.message,
              source: value.error.source,
            },
            retryable: value.retryable,
          }
        : null;
    default:
      return null;
  }
}

function parseOutcome(value: unknown): Outcome | null {
  if (
    !isRecord(value) ||
    (value.status !== "success" &&
      value.status !== "partial" &&
      value.status !== "failed") ||
    (value.summary !== null && typeof value.summary !== "string") ||
    !Array.isArray(value.artifacts)
  ) {
    return null;
  }
  const artifacts: ArtifactRef[] = [];
  for (const raw of value.artifacts) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.kind !== "string" ||
      (raw.url !== null && typeof raw.url !== "string")
    ) {
      return null;
    }
    artifacts.push({ id: raw.id, kind: raw.kind, url: raw.url });
  }
  return { status: value.status, summary: value.summary, artifacts };
}

function isErrorSource(value: unknown): value is ErrorSource {
  return (
    value === "harness" ||
    value === "gateway" ||
    value === "platform" ||
    value === "provider"
  );
}

function parsePersistedEnvelope(
  row: SessionTurnEventRow,
): Result<AgentEventEnvelope, SessionTurnStreamError> {
  let event: unknown;

  try {
    event = JSON.parse(row.payload);
  } catch {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const parsed = parseAgentEventEnvelope({
    turnId: row.turn_id,
    sequence: row.turn_sequence,
    emittedAt: row.at,
    event,
  });

  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_persisted_state" } };
}

function rowToRunningState(
  row: SessionTurnStreamRow,
  requestId: RequestId,
  organisationId: OrganisationId,
  inputDigest: SessionTurnInputDigest | null,
): Variant<SessionTurnStreamState, "running"> {
  return {
    kind: "running",
    turnId: row.turn_id,
    requestId,
    organisationId,
    inputDigest,
    revision: sessionTurnLifecycleRevision(row),
    lastSequence: row.last_sequence,
    errorDetail: null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function rowToCompleteState(
  row: SessionTurnStreamRow,
  requestId: RequestId,
  organisationId: OrganisationId,
  inputDigest: SessionTurnInputDigest | null,
): Variant<SessionTurnStreamState, "complete"> {
  return {
    kind: "complete",
    turnId: row.turn_id,
    requestId,
    organisationId,
    inputDigest,
    revision: sessionTurnLifecycleRevision(row),
    lastSequence: row.last_sequence,
    errorDetail: null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function rowToFailedState(
  row: SessionTurnStreamRow,
  requestId: RequestId,
  organisationId: OrganisationId,
  inputDigest: SessionTurnInputDigest | null,
  errorDetail: string,
): Variant<SessionTurnStreamState, "failed"> {
  return {
    kind: "failed",
    turnId: row.turn_id,
    requestId,
    organisationId,
    inputDigest,
    revision: sessionTurnLifecycleRevision(row),
    lastSequence: row.last_sequence,
    errorDetail,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function sessionTurnLifecycleRevision(row: SessionTurnStreamRow): number {
  const progressRevision = row.last_sequence < 0 ? 1 : row.last_sequence + 2;

  return row.state === "running" ? progressRevision : progressRevision + 1;
}
