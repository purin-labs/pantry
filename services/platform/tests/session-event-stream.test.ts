/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { createSessionSchema } from "../src/actors/agent-session-schema";
import {
  persistAgentEventEnvelope,
  type SessionAgentEventInput,
} from "../src/actors/agent-session-event-stream";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireRequestId, requireOrganisationId } from "./test-ids";

describe("session event stream persistence", function sessionEventStreamSuite() {
  it("accepts exact duplicates and rejects conflicts and gaps", function enforcesSequenceIdentity() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const first = eventInput(0, "PONG");

    expect(persistAgentEventEnvelope(sql, first)).toEqual({
      ok: true,
      value: "inserted",
    });
    expect(persistAgentEventEnvelope(sql, first)).toEqual({
      ok: true,
      value: "duplicate",
    });
    expect(persistAgentEventEnvelope(sql, eventInput(0, "CONFLICT"))).toEqual({
      ok: false,
      error: { code: "invalid_persisted_state" },
    });
    expect(persistAgentEventEnvelope(sql, eventInput(2, "GAP"))).toEqual({
      ok: false,
      error: { code: "stream_sequence_gap", expected: 1, received: 2 },
    });
    expect(persistAgentEventEnvelope(sql, eventInput(1, "DONE"))).toEqual({
      ok: true,
      value: "inserted",
    });
  });
});

function eventInput(sequence: number, text: string): SessionAgentEventInput {
  return {
    requestId: requireRequestId("req_stream_fixture"),
    organisationId: requireOrganisationId("organisation_stream_fixture"),
    envelope: {
      turnId: "turn_stream_fixture",
      sequence,
      emittedAt: 1_000 + sequence,
      event: { type: "agent_message", text, finalMessage: false },
    },
  };
}
