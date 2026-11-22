import type { AgentEventEnvelope } from "@purin-labs/contracts";

import type { RequestId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  advanceSessionTurnStream,
  parseAgentEventEnvelope,
  readSessionTurnStream,
} from "./agent-session-turn-stream";

export type SessionAgentEventInput = {
  requestId: RequestId;
  organisationId: OrganisationId;
  envelope: AgentEventEnvelope;
};

type SessionAgentEventPersistError =
  | { code: "invalid_persisted_state" }
  | { code: "stream_sequence_gap"; expected: number; received: number };

type AcceptedHarnessEventProjection = {
  input: SessionAgentEventInput;
};

export function prepareAcceptedHarnessEventProjection(
  sql: SqlStorage,
  input: {
    organisationId: string;
    turnId: string;
    harnessSequence: number;
    payload: string;
  },
): Result<AcceptedHarnessEventProjection, { code: "invalid_persisted_state" }> {
  let rawEnvelope: unknown;

  try {
    rawEnvelope = JSON.parse(input.payload);
  } catch {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  const parsed = parseAgentEventEnvelope(rawEnvelope);
  const stream = readSessionTurnStream(sql, input.turnId);

  if (
    !parsed.ok ||
    parsed.value.turnId !== input.turnId ||
    parsed.value.sequence !== input.harnessSequence ||
    !stream.ok ||
    stream.value.kind !== "running" ||
    stream.value.organisationId !== input.organisationId
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  return {
    ok: true,
    value: {
      input: {
        requestId: stream.value.requestId,
        organisationId: stream.value.organisationId,
        envelope: {
          ...parsed.value,
          sequence: input.harnessSequence - 1,
        },
      },
    },
  };
}

export function persistAcceptedHarnessEventProjection(
  sql: SqlStorage,
  projection: AcceptedHarnessEventProjection,
): Result<null, SessionAgentEventPersistError> {
  const persisted = persistAgentEventEnvelope(sql, projection.input);

  if (!persisted.ok) {
    return persisted;
  }

  const advanced = advanceSessionTurnStream(
    sql,
    projection.input.envelope.turnId,
    projection.input.envelope.sequence,
    projection.input.envelope.emittedAt,
  );

  return advanced.ok
    ? advanced
    : { ok: false, error: { code: "invalid_persisted_state" } };
}

export function persistAgentEventEnvelope(
  sql: SqlStorage,
  input: SessionAgentEventInput,
): Result<"inserted" | "duplicate", SessionAgentEventPersistError> {
  const existing = sql
    .exec<{
      organisation_id: string;
      request_id: string;
      payload: string;
      at: number;
    }>(
      `SELECT organisation_id, request_id, payload, at
       FROM session_event
       WHERE turn_id = ? AND turn_sequence = ?
       LIMIT 1`,
      input.envelope.turnId,
      input.envelope.sequence,
    )
    .toArray()[0];

  if (existing !== undefined) {
    if (
      existing.organisation_id !== input.organisationId ||
      existing.request_id !== input.requestId ||
      existing.payload !== JSON.stringify(input.envelope.event) ||
      existing.at !== input.envelope.emittedAt
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }

    return { ok: true, value: "duplicate" };
  }

  const cursor = sql
    .exec<{ last_sequence: number }>(
      `SELECT COALESCE(MAX(turn_sequence), -1) AS last_sequence
       FROM session_event
       WHERE turn_id = ?`,
      input.envelope.turnId,
    )
    .toArray()[0];
  const expected = (cursor?.last_sequence ?? -1) + 1;

  if (input.envelope.sequence !== expected) {
    return {
      ok: false,
      error: {
        code: "stream_sequence_gap",
        expected,
        received: input.envelope.sequence,
      },
    };
  }

  sql.exec(
    `INSERT INTO session_event (
       organisation_id,
       request_id,
       kind,
       payload,
       at,
       archived,
       turn_id,
       turn_sequence
     )
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    input.organisationId,
    input.requestId,
    input.envelope.event.type,
    JSON.stringify(input.envelope.event),
    input.envelope.emittedAt,
    input.envelope.turnId,
    input.envelope.sequence,
  );

  return { ok: true, value: "inserted" };
}
