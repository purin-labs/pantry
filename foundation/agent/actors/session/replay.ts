import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  failSessionTurnStream,
  readSessionTurnReplay,
  waitForSessionTurnStreamChange,
  type SessionTurnStreamError,
  type SessionTurnStreamRecord,
} from "../agent-session-turn-stream";
import { errorMessage } from "@purin-labs/std";
import type { SessionActor } from "./session-actor";
import { SESSION_REPLAY_MAX_POLL_MS, SESSION_REPLAY_POLL_MS } from "./support";
import type {
  SessionAgentFanout,
  SessionReplayInput,
  SessionReplayMetrics,
  SessionStateError,
} from "./types";

async function writeSessionStreamRecord(
  fanout: SessionAgentFanout,
  record: SessionTurnStreamRecord,
): Promise<void> {
  return writeSessionStreamRecords(fanout, [record]);
}

/** Write the records as one chunk, one line each. */
async function writeSessionStreamRecords(
  fanout: SessionAgentFanout,
  records: readonly SessionTurnStreamRecord[],
): Promise<void> {
  if (fanout.state.kind === "detached" || records.length === 0) {
    return;
  }

  try {
    await fanout.state.writer.write(
      new TextEncoder().encode(
        records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      ),
    );
  } catch (error) {
    fanout.state = { kind: "detached", detail: errorMessage(error) };
    traceWarn("session.stream_consumer_detached", {
      requestId: newRequestId(),
      turn_id: fanout.turnId,
      detail: fanout.state.detail,
    });
  }
}

function detachSessionFanout(fanout: SessionAgentFanout, error: unknown): void {
  fanout.state = { kind: "detached", detail: errorMessage(error) };
}

async function closeSessionFanout(fanout: SessionAgentFanout): Promise<void> {
  if (fanout.state.kind === "detached") {
    return;
  }

  try {
    await fanout.state.writer.close();
  } catch (error) {
    fanout.state = { kind: "detached", detail: errorMessage(error) };
  }
}

export function createSessionReplayResponse(
  session: Pick<SessionActor, "sql" | "durableState">,
  input: SessionReplayInput,
): Result<Response, SessionStateError> {
  const replay = readSessionTurnReplay(session.sql, input);

  if (!replay.ok) {
    return { ok: false, error: replay.error };
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const metrics: SessionReplayMetrics = {
    requestId: replay.value.state.requestId,
    organisationId: input.organisationId,
    turnId: input.turnId,
    startedAt: Date.now(),
    pollCount: 0,
    emptyPollCount: 0,
    rowsReturned: 0,
    firstOutputAt: null,
  };
  session.durableState.waitUntil(
    runSessionReplayStream(session, input, writer, metrics),
  );

  return {
    ok: true,
    value: new Response(stream.readable, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    }),
  };
}

async function runSessionReplayStream(
  session: Pick<SessionActor, "sql" | "durableState">,
  input: SessionReplayInput,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  metrics: SessionReplayMetrics,
): Promise<void> {
  const fanout: SessionAgentFanout = {
    turnId: input.turnId,
    state: { kind: "attached", writer },
  };
  void writer.closed.catch(detachSessionFanout.bind(null, fanout));
  let afterSequence = input.afterSequence;
  let revisionSent = 0;
  let pollDelayMs = SESSION_REPLAY_POLL_MS;

  for (;;) {
    const replay = readSessionTurnReplay(session.sql, {
      turnId: input.turnId,
      organisationId: input.organisationId,
      afterSequence,
    });

    if (!replay.ok) {
      await writeSessionStreamRecord(fanout, {
        kind: "failed",
        turnId: input.turnId,
        lastSequence: afterSequence,
        detail: replay.error.code,
      });
      traceSessionReplayMetrics(metrics, "read_failed");
      await closeSessionFanout(fanout);
      return;
    }

    // Everything this read found leaves in one write. The consumer reads the
    // placement fence once for each chunk it receives, so the last events of
    // a turn and its terminal record must not arrive as separate chunks.
    const records: SessionTurnStreamRecord[] = [];
    const hasNewRevision = replay.value.state.revision > revisionSent;
    if (hasNewRevision) {
      records.push({
        kind: "upstream_revision",
        turnId: input.turnId,
        revision: replay.value.state.revision,
      });
      revisionSent = replay.value.state.revision;
    }

    metrics.rowsReturned += replay.value.envelopes.length;
    if (hasNewRevision || replay.value.envelopes.length > 0) {
      pollDelayMs = SESSION_REPLAY_POLL_MS;
    }
    for (const envelope of replay.value.envelopes) {
      records.push({ kind: "event", envelope });
      afterSequence = envelope.sequence;
    }

    const terminal =
      replay.value.caughtUp && replay.value.state.kind !== "running"
        ? replay.value.state
        : null;
    if (terminal !== null) {
      records.push(
        terminal.kind === "complete"
          ? {
              kind: "complete",
              turnId: input.turnId,
              lastSequence: terminal.lastSequence,
            }
          : {
              kind: "failed",
              turnId: input.turnId,
              lastSequence: terminal.lastSequence,
              detail: terminal.errorDetail,
            },
      );
    }

    await writeSessionStreamRecords(fanout, records);
    if (replay.value.envelopes.length > 0) metrics.firstOutputAt ??= Date.now();
    if (terminal !== null) {
      traceSessionReplayMetrics(metrics, terminal.kind);
      await closeSessionFanout(fanout);
      return;
    }
    if (sessionFanoutDetached(fanout)) {
      traceSessionReplayMetrics(metrics, "detached");
      return;
    }
    // The write above was a wait, and so more may have been written. Read
    // again at once. The reader waits only after a read that found nothing,
    // so no write can fall between that read and the wait.
    if (!replay.value.caughtUp || records.length > 0) continue;

    metrics.pollCount += 1;
    metrics.emptyPollCount += 1;
    await waitForSessionTurnStreamChange(
      session.sql,
      input.turnId,
      pollDelayMs,
    );
    pollDelayMs = Math.min(pollDelayMs * 2, SESSION_REPLAY_MAX_POLL_MS);
    if (sessionFanoutDetached(fanout)) {
      traceSessionReplayMetrics(metrics, "detached");
      return;
    }
  }
}

function sessionFanoutDetached(fanout: SessionAgentFanout): boolean {
  return fanout.state.kind === "detached";
}

function traceSessionReplayMetrics(
  metrics: SessionReplayMetrics,
  outcome: string,
): void {
  const completedAt = Date.now();
  traceLog("session.replay_metrics", {
    requestId: metrics.requestId,
    organisation_id: metrics.organisationId,
    turn_id: metrics.turnId,
    outcome,
    duration_ms: completedAt - metrics.startedAt,
    poll_count: metrics.pollCount,
    empty_poll_count: metrics.emptyPollCount,
    rows_returned: metrics.rowsReturned,
    time_to_first_output_ms:
      metrics.firstOutputAt === null
        ? null
        : metrics.firstOutputAt - metrics.startedAt,
    time_to_final_output_ms: completedAt - metrics.startedAt,
  });
}

/** A release that failed outright is repeated like one that an owner deferred. */
export function deferredExecutionRelease(): { readonly deferred: boolean } {
  return { deferred: true };
}

export function failOrphanedSessionTurnStreams(
  sql: SqlStorage,
  interruptedAt: number,
  detail:
    | "operator_interrupt_without_active_turn"
    | "code_mode_execution_unresumable" = "operator_interrupt_without_active_turn",
): Result<number, SessionTurnStreamError> {
  const rows = sql
    .exec<{ turn_id: string }>(
      `SELECT turn_id
     FROM session_turn_stream
     WHERE state = 'running'
     ORDER BY turn_id`,
    )
    .toArray();
  for (const row of rows) {
    const failed = failSessionTurnStream(
      sql,
      row.turn_id,
      detail,
      interruptedAt,
    );
    if (!failed.ok) return failed;
  }
  return { ok: true, value: rows.length };
}
