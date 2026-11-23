/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";

import { createSessionSchema } from "@purin-labs/agent/actors/agent-session-schema";
import { createSessionReplayResponse } from "@purin-labs/agent/actors/session/replay";
import { persistAgentEventEnvelope } from "@purin-labs/agent/actors/agent-session-event-stream";
import {
  advanceSessionTurnStream,
  beginSessionTurnStream,
  completeSessionTurnStream,
  failSessionTurnStream,
  hasRunningSessionTurn,
  parseSessionTurnStreamRecord,
  readRunningSessionTurn,
  readSessionTurnReplay,
} from "@purin-labs/agent/actors/agent-session-turn-stream";
import { type RequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  requireRequestId,
  requireSessionTurnInputDigest,
  requireOrganisationId,
} from "./test-ids";

describe("session turn stream", function sessionTurnStreamSuite() {
  it(
    "keeps a long-running producer alive across observer detachment",
    survivesLongObserver,
  );
  it("replays persisted envelopes from a cursor after idempotent completion", function replaysCompletedTurn() {
    const fixture = streamFixture();
    const sql = fixture.sql;
    const identity = streamIdentity();

    expect(beginSessionTurnStream(sql, identity)).toEqual({
      ok: true,
      value: "started",
    });
    expect(hasRunningSessionTurn(sql)).toBe(true);
    expect(beginSessionTurnStream(sql, identity)).toEqual({
      ok: true,
      value: "existing",
    });
    persistEnvelope(sql, identity, 0, "PO");
    persistEnvelope(sql, identity, 1, "NG");
    expect(completeSessionTurnStream(sql, identity.turnId, 1, 1_003)).toEqual({
      ok: true,
      value: null,
    });
    expect(hasRunningSessionTurn(sql)).toBe(false);
    expect(completeSessionTurnStream(sql, identity.turnId, 1, 1_004)).toEqual({
      ok: true,
      value: null,
    });

    const replay = readSessionTurnReplay(sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: 0,
    });

    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.state.kind).toBe("complete");
      expect(replay.value.envelopes).toHaveLength(1);
      expect(replay.value.envelopes[0]?.sequence).toBe(1);
    }
  });

  it("rejects reuse of a turn id with different validated input", function rejectsInputMismatch() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    expect(beginSessionTurnStream(fixture.sql, identity)).toEqual({
      ok: true,
      value: "started",
    });
    expect(
      beginSessionTurnStream(fixture.sql, {
        turnId: identity.turnId,
        requestId: identity.requestId,
        organisationId: identity.organisationId,
        inputDigest: requireSessionTurnInputDigest("b".repeat(64)),
        startedAt: identity.startedAt,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_state" } });
  });

  it("returns the sole running turn for interruption", function readsRunningTurn() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    expect(readRunningSessionTurn(fixture.sql)).toEqual({
      ok: true,
      value: null,
    });
    expect(beginSessionTurnStream(fixture.sql, identity)).toEqual({
      ok: true,
      value: "started",
    });
    expect(readRunningSessionTurn(fixture.sql)).toMatchObject({
      ok: true,
      value: {
        kind: "running",
        turnId: identity.turnId,
        requestId: identity.requestId,
        organisationId: identity.organisationId,
      },
    });
  });

  it("persists a failed terminal state without inventing an event", function replaysFailedTurn() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    beginSessionTurnStream(fixture.sql, identity);
    expect(
      failSessionTurnStream(
        fixture.sql,
        identity.turnId,
        "adapter_disconnected",
        1_001,
      ),
    ).toEqual({
      ok: true,
      value: null,
    });

    const replay = readSessionTurnReplay(fixture.sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: -1,
    });

    expect(replay).toMatchObject({
      ok: true,
      value: {
        state: {
          kind: "failed",
          lastSequence: -1,
          errorDetail: "adapter_disconnected",
        },
        envelopes: [],
      },
    });
  });

  it("reconstructs accepted output from persisted storage after consumer disconnect", function resumesAfterDisconnect() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    beginSessionTurnStream(fixture.sql, identity);
    persistEnvelope(fixture.sql, identity, 0, "M66");

    const detachedConsumer = readSessionTurnReplay(fixture.sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: -1,
    });

    expect(detachedConsumer).toMatchObject({
      ok: true,
      value: { state: { kind: "running" }, caughtUp: true },
    });

    const recreatedSql = sqlStorage(fixture.storage);
    persistEnvelope(recreatedSql, identity, 1, "PONG");
    completeSessionTurnStream(recreatedSql, identity.turnId, 1, 1_004);

    const resumedConsumer = readSessionTurnReplay(recreatedSql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: 0,
    });

    expect(resumedConsumer).toMatchObject({
      ok: true,
      value: { state: { kind: "complete" }, caughtUp: true },
    });
    expect(
      replayedAgentText(detachedConsumer) + replayedAgentText(resumedConsumer),
    ).toBe("M66PONG");
  });

  it("replays persisted output before a cancelled adapter terminal", function replaysCancelledTurn() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    beginSessionTurnStream(fixture.sql, identity);
    persistEnvelope(fixture.sql, identity, 0, "partial");
    failSessionTurnStream(
      fixture.sql,
      identity.turnId,
      "adapter_cancelled",
      1_003,
    );

    const replay = readSessionTurnReplay(fixture.sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: -1,
    });

    expect(replay).toMatchObject({
      ok: true,
      value: {
        state: {
          kind: "failed",
          lastSequence: 0,
          errorDetail: "adapter_cancelled",
        },
        caughtUp: true,
      },
    });
    expect(replayedAgentText(replay)).toBe("partial");
  });

  it("pages long replay streams without losing the terminal cursor", function pagesReplay() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    beginSessionTurnStream(fixture.sql, identity);
    for (let sequence = 0; sequence <= 256; sequence += 1) {
      persistEnvelope(fixture.sql, identity, sequence, `${sequence}`);
    }
    completeSessionTurnStream(fixture.sql, identity.turnId, 256, 2_000);

    const first = readSessionTurnReplay(fixture.sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: -1,
    });
    const second = readSessionTurnReplay(fixture.sql, {
      turnId: identity.turnId,
      organisationId: identity.organisationId,
      afterSequence: 255,
    });

    expect(first).toMatchObject({ ok: true, value: { caughtUp: false } });
    expect(first.ok && first.value.envelopes).toHaveLength(256);
    expect(second).toMatchObject({ ok: true, value: { caughtUp: true } });
    expect(second.ok && second.value.envelopes[0]?.sequence).toBe(256);
  });

  it("rejects invalid replay cursors, identities, and terminal records", function rejectsInvalidBoundaries() {
    const fixture = streamFixture();
    const identity = streamIdentity();
    const otherOrganisation = requireOrganisationId("organisation_other");

    beginSessionTurnStream(fixture.sql, identity);
    expect(
      readSessionTurnReplay(fixture.sql, {
        turnId: identity.turnId,
        organisationId: identity.organisationId,
        afterSequence: -2,
      }),
    ).toEqual({ ok: false, error: { code: "stream_cursor_invalid" } });
    expect(
      readSessionTurnReplay(fixture.sql, {
        turnId: identity.turnId,
        organisationId: otherOrganisation,
        afterSequence: -1,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_state" } });
    expect(
      parseSessionTurnStreamRecord({
        kind: "failed",
        turnId: identity.turnId,
        lastSequence: -2,
        detail: "bad",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_state" } });
  });

  it("rejects an event whose persisted identity differs from its turn", function rejectsEventIdentityMismatch() {
    const fixture = streamFixture();
    const identity = streamIdentity();

    beginSessionTurnStream(fixture.sql, identity);
    persistEnvelope(fixture.sql, identity, 0, "PONG");
    fixture.sql.exec(
      `UPDATE session_event
       SET request_id = ?
       WHERE turn_id = ? AND turn_sequence = 0`,
      "req_corrupted",
      identity.turnId,
    );

    expect(
      readSessionTurnReplay(fixture.sql, {
        turnId: identity.turnId,
        organisationId: identity.organisationId,
        afterSequence: -1,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_state" } });
  });
});

class ReplayObserver {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
}

async function survivesLongObserver(): Promise<void> {
  const fixture = streamFixture();
  const identity = streamIdentity();
  const observer = new ReplayObserver();
  const session = {
    sql: fixture.sql,
    durableState: observer as unknown as DurableObjectState,
  };
  beginSessionTurnStream(fixture.sql, identity);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_001);
  vi.stubGlobal("scheduler", { wait: yieldReplayPoll });
  try {
    const response = createSessionReplayResponse(session, {
      organisationId: identity.organisationId,
      turnId: identity.turnId,
      afterSequence: -1,
    });
    if (!response.ok || response.value.body === null)
      throw new Error("missing replay response");
    const reader = response.value.body.getReader();
    await reader.read();
    clock.mockReturnValue(200_000);
    await yieldReplayPoll();
    expect(readRunningSessionTurn(fixture.sql)).toMatchObject({
      ok: true,
      value: { kind: "running" },
    });
    await reader.cancel();
    await Promise.all(observer.pending);
    expect(readRunningSessionTurn(fixture.sql)).toMatchObject({
      ok: true,
      value: { kind: "running" },
    });
    persistEnvelope(fixture.sql, identity, 0, "finished after disconnect");
    expect(
      completeSessionTurnStream(fixture.sql, identity.turnId, 0, 200_001).ok,
    ).toBe(true);
    await Promise.all(observer.pending);
    const reconnected = createSessionReplayResponse(session, {
      organisationId: identity.organisationId,
      turnId: identity.turnId,
      afterSequence: -1,
    });
    if (!reconnected.ok) throw new Error(reconnected.error.code);
    const text = await reconnected.value.text();
    expect(text).toContain("finished after disconnect");
    expect(text).toContain('"kind":"complete"');
    expect(text).not.toContain('"kind":"failed"');
    await Promise.all(observer.pending);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
}

function yieldReplayPoll(): Promise<void> {
  return new Promise(resolveReplayPoll);
}

function resolveReplayPoll(resolve: () => void): void {
  setTimeout(resolve, 0);
}

function streamFixture() {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createSessionSchema(sql);
  return { sql, storage: fixture.storage };
}

function streamIdentity() {
  return {
    turnId: "turn_replay_fixture",
    requestId: requireRequestId("req_replay_fixture"),
    organisationId: requireOrganisationId("organisation_replay_fixture"),
    inputDigest: requireSessionTurnInputDigest("a".repeat(64)),
    startedAt: 1_000,
  };
}

function persistEnvelope(
  sql: SqlStorage,
  identity: {
    turnId: string;
    requestId: RequestId;
    organisationId: OrganisationId;
  },
  sequence: number,
  text: string,
): void {
  const envelope = {
    turnId: identity.turnId,
    sequence,
    emittedAt: 1_001 + sequence,
    event: { type: "agent_message" as const, text, finalMessage: false },
  };
  const persisted = persistAgentEventEnvelope(sql, {
    requestId: identity.requestId,
    organisationId: identity.organisationId,
    envelope,
  });

  expect(persisted.ok).toBe(true);
  expect(
    advanceSessionTurnStream(
      sql,
      identity.turnId,
      sequence,
      envelope.emittedAt,
    ),
  ).toEqual({
    ok: true,
    value: null,
  });
}

function replayedAgentText(
  replay: ReturnType<typeof readSessionTurnReplay>,
): string {
  if (!replay.ok) {
    return "";
  }

  let text = "";

  for (const envelope of replay.value.envelopes) {
    if (envelope.event.type === "agent_message") {
      text += envelope.event.text;
    }
  }

  return text;
}
