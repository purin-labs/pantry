/// <reference types="@cloudflare/workers-types" />

import type {
  AcceptedInputRef,
  HarnessEventCursor,
  HarnessHistoryContent,
  HarnessTurnLease,
  ProcessingSession,
  TurnIdentity,
} from "@purin-labs/contracts";
import { describe, expect, test } from "vitest";
import {
  acceptHarnessEvent,
  appendHarnessHistory,
  commitHarnessCheckpoint,
  eraseHarnessHistoryForOrganisation,
  HARNESS_HISTORY_WARNING_BYTES,
  inspectLatestStoredHarnessCheckpoint,
  issueHarnessTurnLease,
  MAX_DELIVERY_SEGMENT_BYTES,
  MAX_HARNESS_HISTORY_BYTES,
  MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES,
  parsePersistedHarnessTurnLease,
  preflightHarnessTurnLease,
  readHarnessHistory,
  readHarnessHistoryUsage,
  type CommitHarnessCheckpointInput,
  type HarnessAuthorityStorage,
} from "../src/actors/agent-session-harness-authority";
import { createSessionSchema } from "../src/actors/agent-session-schema";
import {
  beginSessionTurnStream,
  readSessionTurnReplay,
} from "../src/actors/agent-session-turn-stream";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import type { Variant } from "@purin-labs/type-utils";
import {
  requireRequestId,
  requireSessionTurnInputDigest,
  requireOrganisationId,
} from "./test-ids";

const DIGEST_1 = "1".repeat(64);
const DIGEST_2 = "2".repeat(64);
const AUTHORITY_PARTITION_DIGEST = "4".repeat(64);
const CONTEXT_BUNDLE_DIGEST = "6".repeat(64);
const MODEL_ROUTE_DIGEST =
  "fd4fee0fca8f32a7d1c185584c6d2bea9a6d37e3781d7452385e53ff88618a1c";

describe("AgentSession harness authority", function harnessAuthoritySuite() {
  test("rejects repeated tool IDs inside one assistant response", async function rejectsAmbiguousCalls() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    const initial = await appendHarnessHistory(
      storage,
      historyInput(lease, 1, null, "test"),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    const calls = settledEffectCallInput(
      lease,
      2,
      initial.value.cursor.lastEntryDigest,
    );
    calls.entry.content.push(...calls.entry.content);
    expect(await appendHarnessHistory(storage, calls)).toEqual({
      ok: false,
      error: {
        code: "harness_history_order_invalid",
        reason: "duplicate_tool_call",
      },
    });
    expect(fixture.historyCursor()).toEqual({
      history_sequence: 1,
      history_digest: initial.value.cursor.lastEntryDigest,
    });
  });

  test("restores only the current authority-bound harness lease shape", function restoresLease() {
    const lease = harnessLease();
    expect(parsePersistedHarnessTurnLease(lease)).toEqual(lease);
    expect(
      parsePersistedHarnessTurnLease({
        leaseId: lease.leaseId,
        session: lease.session,
        turn: lease.turn,
        runtimeLease: lease.runtimeLease,
        runtimeRevision: lease.runtimeRevision,
        issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt,
      }),
    ).toBeNull();
    expect(
      parsePersistedHarnessTurnLease({
        ...lease,
        requestAuthority: { kind: "invalid" },
      }),
    ).toBeNull();
    expect(
      parsePersistedHarnessTurnLease({ ...lease, legacy: true }),
    ).toBeNull();
  });

  test("fences neutral history with exact replay and contiguous cursors", async function fencesHistory() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    const first = historyInput(lease, 1, null, "first");
    const accepted = await appendHarnessHistory(storage, first);
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        kind: "advanced",
        cursor: {
          lastSequence: 1,
        },
      },
    });
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.value.cursor.lastEntryDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await appendHarnessHistory(storage, first)).toMatchObject({
      ok: true,
      value: { kind: "duplicate" },
    });
    expect(
      readHarnessHistoryUsage(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).toMatchObject({ ok: true, value: { entryCount: 1 } });
    expect(
      await appendHarnessHistory(
        storage,
        historyInput(lease, 1, null, "conflict"),
      ),
    ).toEqual({
      ok: false,
      error: { code: "harness_history_divergent_duplicate" },
    });
    expect(
      await appendHarnessHistory(storage, { ...first, sequence: 3 }),
    ).toEqual({
      ok: false,
      error: { code: "harness_history_gap" },
    });
    expect(
      await appendHarnessHistory(storage, {
        leaseId: lease.leaseId,
        sessionId: lease.session.sessionId,
        turn: lease.turn,
        sequence: 2,
        previousDigest: accepted.value.cursor.lastEntryDigest,
        entry: {
          kind: "tool_result",
          turn: lease.turn,
          callId: "call_without_authority",
          tool: "commerce_entity_context",
          outcome: {
            kind: "succeeded",
            output: {
              kind: "inline",
              content: [{ kind: "text", text: "[]" }],
              digest: "d".repeat(64),
            },
          },
          authority: { kind: "read", resultDigest: "d".repeat(64) },
          acceptedAt: 12,
        },
        acceptedAt: 12,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "harness_history_order_invalid",
        reason: "tool_result_without_call",
      },
    });
    const replayed = await readHarnessHistory(
      fixture.sqlStorage(),
      lease.session.sessionId,
      lease.session.organisationId,
    );
    expect(replayed).toMatchObject({
      ok: true,
      value: {
        kind: "bounded_history",
        history: {
          cursor: { lastSequence: 1 },
          entries: [{ kind: "user_input" }],
        },
      },
    });
    await expect(
      readHarnessHistory(
        fixture.sqlStorage(),
        lease.session.sessionId,
        "organisation_other",
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "harness_history_organisation_mismatch" },
    });
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_history SET entry_digest = ? WHERE session_id = ? AND sequence = 1",
        "0".repeat(64),
        lease.session.sessionId,
      );
    await expect(
      readHarnessHistory(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "harness_history_cursor_mismatch" },
    });
  });

  test("rolls back history and usage together when the counter write fails", async function rollsBackUsage() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    fixture.failOnceWhenWritingUsage();

    await expect(
      appendHarnessHistory(storage, historyInput(lease, 1, null, "first")),
    ).rejects.toThrow("injected_sql_failure:INSERT INTO session_harness_usage");
    expect(fixture.count("session_harness_history")).toBe(0);
    expect(fixture.count("session_harness_usage")).toBe(0);
    expect(fixture.historyCursor()).toEqual({
      history_sequence: null,
      history_digest: null,
    });
  });

  test("stops above the restore materialization ceiling before reading payloads", async function boundsRestoreMemory() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    expect(
      (
        await appendHarnessHistory(
          storage,
          historyInput(lease, 1, null, "first"),
        )
      ).ok,
    ).toBe(true);
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_usage SET inline_byte_count = ? WHERE session_id = ?",
        MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES + 1,
        lease.session.sessionId,
      );
    fixture.failOnceWhenReadingHistory();

    await expect(
      readHarnessHistory(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "history_materialization_limit",
        requiredBytes: MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES + 1,
        allowedBytes: MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES,
      },
    });
  });

  test("rejects history that would exceed the aggregate inline-byte budget", async function boundsHistoryBudget() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    const first = await appendHarnessHistory(
      storage,
      historyInput(lease, 1, null, "first"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.code);

    fixture.sqlStorage().exec("PRAGMA ignore_check_constraints = ON");
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_history SET byte_length = ? WHERE session_id = ? AND sequence = 1",
        MAX_HARNESS_HISTORY_BYTES,
        lease.session.sessionId,
      );
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_usage SET inline_byte_count = ? WHERE session_id = ?",
        MAX_HARNESS_HISTORY_BYTES,
        lease.session.sessionId,
      );
    fixture.sqlStorage().exec("PRAGMA ignore_check_constraints = OFF");

    const second = await appendHarnessHistory(storage, {
      leaseId: lease.leaseId,
      sessionId: lease.session.sessionId,
      turn: lease.turn,
      sequence: 2,
      previousDigest: first.value.cursor.lastEntryDigest,
      entry: {
        kind: "assistant_message",
        turn: lease.turn,
        model: "gpt-5.6-sol",
        content: [
          { kind: "text", text: "done", continuation: { kind: "none" } },
        ],
        stopReason: "completed",
        usage: {
          modelCalls: 1,
          callsWithUsage: 1,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        acceptedAt: 12,
      },
      acceptedAt: 12,
    });
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: "harness_history_budget_exceeded",
        limit: "inline_bytes",
        current: MAX_HARNESS_HISTORY_BYTES,
        maximum: MAX_HARNESS_HISTORY_BYTES,
      },
    });
    expect(
      readHarnessHistoryUsage(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).toEqual({
      ok: true,
      value: {
        entryCount: 1,
        inlineBytes: MAX_HARNESS_HISTORY_BYTES,
        warning: true,
        hardLimit: true,
      },
    });
    expect(fixture.count("session_harness_history")).toBe(1);
    expect(fixture.cursor()).toMatchObject({ last_sequence: null });
  });

  test("marks the exact append that crosses the history warning threshold", async function marksHistoryWarningCrossing() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    const first = await appendHarnessHistory(
      storage,
      historyInput(lease, 1, null, "first"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.code);

    fixture.sqlStorage().exec("PRAGMA ignore_check_constraints = ON");
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_history SET byte_length = ? WHERE session_id = ? AND sequence = 1",
        HARNESS_HISTORY_WARNING_BYTES - 1,
        lease.session.sessionId,
      );
    fixture
      .sqlStorage()
      .exec(
        "UPDATE session_harness_usage SET inline_byte_count = ? WHERE session_id = ?",
        HARNESS_HISTORY_WARNING_BYTES - 1,
        lease.session.sessionId,
      );
    fixture.sqlStorage().exec("PRAGMA ignore_check_constraints = OFF");

    const second = await appendHarnessHistory(storage, {
      leaseId: lease.leaseId,
      sessionId: lease.session.sessionId,
      turn: lease.turn,
      sequence: 2,
      previousDigest: first.value.cursor.lastEntryDigest,
      entry: {
        kind: "assistant_message",
        turn: lease.turn,
        model: "gpt-5.6-sol",
        content: [
          { kind: "text", text: "done", continuation: { kind: "none" } },
        ],
        stopReason: "completed",
        usage: {
          modelCalls: 1,
          callsWithUsage: 1,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        acceptedAt: 12,
      },
      acceptedAt: 12,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        kind: "advanced",
        warningCrossed: true,
        usage: { warning: true, hardLimit: false },
      },
    });
  });

  test("erases organisation-owned history and its session authority rows", async function erasesHistory() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);
    expect(
      (
        await appendHarnessHistory(
          storage,
          historyInput(lease, 1, null, "first"),
        )
      ).ok,
    ).toBe(true);

    const erased = eraseHarnessHistoryForOrganisation(
      storage,
      "organisation_1",
    );
    expect(erased).toEqual({
      ok: true,
      value: {
        historyRows: 1,
        checkpointRows: 0,
        leaseRows: 1,
        deliveryRows: 0,
        objectKeys: [],
      },
    });
    expect(fixture.count("session_harness_history")).toBe(0);
    expect(
      fixture
        .sqlStorage()
        .exec("SELECT COUNT(*) AS count FROM session_harness_lease")
        .toArray()[0]?.count,
    ).toBe(0);
    await expect(
      readHarnessHistory(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "empty",
        history: { cursor: null, entries: [] },
        throughSequence: 0,
        encodedBytes: 0,
      },
    });
  });

  test("erases checkpoint-only session authority rows by checkpoint organisation", function erasesCheckpointOnlyHistory() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    const checkpoint = checkpointRecord({
      kind: "accepted",
      turn: lease.turn,
      lastSequence: 1,
      lastEventDigest: DIGEST_1,
    });
    fixture.sqlStorage().exec(
      `INSERT INTO session_harness_checkpoint (
         session_id, turn_id, last_sequence, last_event_digest,
         checkpoint_projection, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      checkpoint.session.sessionId,
      checkpoint.cursor.turn.turnId,
      checkpoint.cursor.lastSequence,
      checkpoint.cursor.lastEventDigest,
      JSON.stringify(checkpoint),
      13,
    );
    fixture.sqlStorage().exec(
      `INSERT INTO turn_delivery_segment (
         session_id, turn_id, sequence, event_digest, payload, byte_length, accepted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lease.session.sessionId,
      lease.turn.turnId,
      1,
      DIGEST_1,
      "{}",
      2,
      10,
    );

    const erased = eraseHarnessHistoryForOrganisation(
      storage,
      "organisation_1",
    );
    expect(erased).toEqual({
      ok: true,
      value: {
        historyRows: 0,
        checkpointRows: 1,
        leaseRows: 0,
        deliveryRows: 1,
        objectKeys: [checkpoint.blob.objectKey],
      },
    });
    expect(fixture.count("session_harness_checkpoint")).toBe(0);
    expect(fixture.count("turn_delivery_segment")).toBe(0);
  });

  test("preserves one settled effect across a crash before checkpoint commit", async function preservesSettledEffectBeforeCheckpoint() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const lease = harnessLease();
    expect(
      issueHarnessTurnLease(storage, processingSession(), lease, 10).ok,
    ).toBe(true);

    const user = await appendHarnessHistory(
      storage,
      historyInput(lease, 1, null, "Read inventory."),
    );
    expect(user.ok).toBe(true);
    if (!user.ok) throw new Error(user.error.code);
    const call = await appendHarnessHistory(
      storage,
      settledEffectCallInput(lease, 2, user.value.cursor.lastEntryDigest),
    );
    expect(call.ok).toBe(true);
    if (!call.ok) throw new Error(call.error.code);
    const resultInput = settledEffectResultInput(
      lease,
      3,
      call.value.cursor.lastEntryDigest,
    );
    const result = await appendHarnessHistory(storage, resultInput);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);

    const restarted = fixture.restart();
    await expect(
      appendHarnessHistory(restarted, resultInput),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "duplicate", cursor: result.value.cursor },
    });
    await expect(
      readHarnessHistory(
        fixture.sqlStorage(),
        lease.session.sessionId,
        lease.session.organisationId,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "bounded_history",
        history: {
          entries: [
            { kind: "user_input" },
            { kind: "assistant_message" },
            {
              kind: "tool_result",
              authority: {
                kind: "provider_effect",
                receiptId: "provider_receipt_crash_1",
              },
            },
          ],
          cursor: result.value.cursor,
        },
      },
    });
    expect(
      inspectLatestStoredHarnessCheckpoint(
        fixture.sqlStorage(),
        lease.session.sessionId,
      ),
    ).toEqual({ kind: "missing" });
  });

  test("persists a contiguous cursor and Pi checkpoint with exact duplicate handling", async function persistsAuthority() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    const session = processingSession();
    const lease = harnessLease();

    expect(issueHarnessTurnLease(storage, session, lease, 10)).toEqual({
      ok: true,
      value: lease,
    });
    const history = await appendHarnessHistory(storage, {
      leaseId: lease.leaseId,
      sessionId: lease.session.sessionId,
      turn: lease.turn,
      sequence: 1,
      previousDigest: null,
      entry: historyUserInput(lease.turn, "first", 10),
      acceptedAt: 10,
    });
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error(history.error.code);

    const first = eventInput(1, DIGEST_1, "first");
    expect(acceptHarnessEvent(storage, first)).toEqual({
      ok: true,
      value: {
        kind: "advanced",
        cursor: {
          kind: "accepted",
          turn: lease.turn,
          lastSequence: 1,
          lastEventDigest: DIGEST_1,
        },
      },
    });
    const duplicate = acceptHarnessEvent(storage, first);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok)
      throw new Error("expected exact duplicate harness event");
    expect(duplicate.value.kind).toBe("duplicate");

    const restarted = fixture.restart();
    const second = acceptHarnessEvent(
      restarted,
      eventInput(2, DIGEST_2, "second"),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected second harness event to advance");

    const checkpoint = checkpointRecord(
      second.value.cursor,
      "pi",
      history.value.cursor,
    );
    const commit = {
      leaseId: lease.leaseId,
      checkpoint,
      committedAt: 13,
    };
    expect(commitHarnessCheckpoint(restarted, commit)).toEqual({
      ok: true,
      value: { kind: "committed", checkpoint },
    });
    expect(commitHarnessCheckpoint(restarted, commit)).toEqual({
      ok: true,
      value: { kind: "duplicate", checkpoint },
    });
    expect(fixture.count("turn_delivery_segment")).toBe(2);
    expect(fixture.count("session_event")).toBe(2);
    expect(fixture.count("session_harness_checkpoint")).toBe(1);
    expect(
      readSessionTurnReplay(fixture.sqlStorage(), {
        organisationId: requireOrganisationId("organisation_1"),
        turnId: lease.turn.turnId,
        afterSequence: -1,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        envelopes: [
          { turnId: "turn_1", sequence: 0 },
          { turnId: "turn_1", sequence: 1 },
        ],
        caughtUp: true,
      },
    });
  });

  test("rejects gaps and stale leases without moving durable progress", function fencesProgress() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    issueHarnessTurnLease(storage, processingSession(), harnessLease(), 10);

    expect(acceptHarnessEvent(storage, eventInput(2, DIGEST_2, "gap"))).toEqual(
      {
        ok: false,
        error: { code: "harness_event_gap" },
      },
    );
    expect(
      acceptHarnessEvent(storage, {
        ...eventInput(1, DIGEST_1, "stale"),
        leaseId: "harness_lease_stale",
      }),
    ).toEqual({ ok: false, error: { code: "harness_lease_stale" } });
    expect(
      acceptHarnessEvent(
        storage,
        eventInput(1, DIGEST_1, "wrong turn", "turn_other"),
      ),
    ).toEqual({ ok: false, error: { code: "harness_event_invalid" } });
    expect(fixture.count("turn_delivery_segment")).toBe(0);
    expect(fixture.count("session_event")).toBe(0);
    expect(fixture.cursor()).toEqual({
      last_sequence: null,
      last_event_digest: null,
    });
  });

  test("rejects oversized delivery segments before durable mutation", function boundsSegments() {
    const fixture = authorityFixture();
    const storage = fixture.restart();
    issueHarnessTurnLease(storage, processingSession(), harnessLease(), 10);

    expect(
      acceptHarnessEvent(
        storage,
        eventInput(1, DIGEST_1, "x".repeat(MAX_DELIVERY_SEGMENT_BYTES + 1)),
      ),
    ).toEqual({
      ok: false,
      error: { code: "harness_delivery_segment_too_large" },
    });
    expect(fixture.count("turn_delivery_segment")).toBe(0);
    expect(fixture.cursor()).toEqual({
      last_sequence: null,
      last_event_digest: null,
    });
  });

  test("preflights only the exact live persisted turn lease", function preflightsTurnLease() {
    const storage = authorityFixture().restart();
    const lease = harnessLease();
    issueHarnessTurnLease(storage, processingSession(), lease, 10);

    expect(preflightHarnessTurnLease(storage, lease, 11)).toEqual({
      ok: true,
      value: lease,
    });
    expect(preflightHarnessTurnLease(storage, lease, 20)).toEqual({
      ok: false,
      error: { code: "harness_lease_expired" },
    });
  });
});

function authorityFixture(): HarnessAuthorityFixture {
  return new HarnessAuthorityFixture();
}
class HarnessAuthorityFixture {
  private readonly fixture = emptySqliteFixture();
  private readonly sql = sqlStorage(this.fixture.storage);

  constructor() {
    createSessionSchema(this.sql);
    const begun = beginSessionTurnStream(this.sql, {
      turnId: "turn_1",
      requestId: requireRequestId("request_1"),
      organisationId: requireOrganisationId("organisation_1"),
      inputDigest: requireSessionTurnInputDigest("a".repeat(64)),
      startedAt: 1,
    });
    if (!begun.ok) throw new Error(begun.error.code);
  }

  restart(): HarnessAuthorityStorage {
    return new TestHarnessAuthorityStorage(this.fixture.database, this.sql);
  }

  sqlStorage(): SqlStorage {
    return this.sql;
  }

  failOnceWhenReadingHistory(): void {
    this.fixture.storage.failOnceWhen({
      queryIncludes: "FROM session_harness_history",
      bindingIndex: null,
      bindingValue: null,
    });
  }

  failOnceWhenWritingUsage(): void {
    this.fixture.storage.failOnceWhen({
      queryIncludes: "INSERT INTO session_harness_usage",
      bindingIndex: null,
      bindingValue: null,
    });
  }

  count(
    table:
      | "turn_delivery_segment"
      | "session_harness_checkpoint"
      | "session_harness_history"
      | "session_harness_usage"
      | "session_event",
  ): number {
    const row = this.fixture.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get();
    return Number(row?.count ?? 0);
  }

  cursor(): { last_sequence: number | null; last_event_digest: string | null } {
    const row = this.fixture.database
      .prepare(
        `SELECT last_sequence, last_event_digest FROM session_harness_lease`,
      )
      .get();
    return {
      last_sequence:
        typeof row?.last_sequence === "number" ? row.last_sequence : null,
      last_event_digest:
        typeof row?.last_event_digest === "string"
          ? row.last_event_digest
          : null,
    };
  }

  historyCursor(): {
    history_sequence: number | null;
    history_digest: string | null;
  } {
    const row = this.fixture.database
      .prepare(
        `SELECT history_sequence, history_digest FROM session_harness_lease`,
      )
      .get();
    return {
      history_sequence:
        typeof row?.history_sequence === "number" ? row.history_sequence : null,
      history_digest:
        typeof row?.history_digest === "string" ? row.history_digest : null,
    };
  }
}

class TestHarnessAuthorityStorage implements HarnessAuthorityStorage {
  constructor(
    private readonly database: ReturnType<
      typeof emptySqliteFixture
    >["database"],
    readonly sql: SqlStorage,
  ) {}

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function processingSession(): ProcessingSession {
  const turn = turnIdentity();
  return {
    identity: {
      organisationId: "organisation_1",
      sessionId: "session_1",
      streamId: "stream_1",
    },
    contract: {
      policyVersion: "policy_1",
      budgetRevision: turn.budgetRevision,
      runtimeRevision: "runtime_1",
      modelRoute: {
        keySource: "platform",
        provider: "openai-compatible",
        model: "gpt-5.6-sol",
      },
      lastEventSequence: 4,
    },
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt: {
        receiptId: "workspace_receipt_1",
        outcome: "accepted",
        workspaceId: "workspace_catalog_1",
        revision: "workspace_1",
        canonicalHead: "f".repeat(64),
        correlationId: "correlation_1",
        causation: { kind: "command", commandId: "workspace_command_1" },
      },
    },
    runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
    activeTurn: { kind: "admitted", state: { identity: turn, admittedAt: 9 } },
  };
}

function harnessLease(): HarnessTurnLease {
  const session = processingSession();
  return {
    leaseId: "harness_lease_1",
    session: session.identity,
    turn: session.activeTurn.state.identity,
    runtimeLease: session.runtimeLease,
    runtimeRevision: session.contract.runtimeRevision,
    requestAuthority: {
      kind: "workflow",
      organisationId: session.identity.organisationId,
      workflowId: "workflow_1",
      workflowRevision: 1,
    },
    authorityPartitionDigest: AUTHORITY_PARTITION_DIGEST,
    issuedAt: 10,
    expiresAt: 20,
  };
}

function turnIdentity(): TurnIdentity {
  return {
    turnId: "turn_1",
    inputId: "input_1",
    turnLeaseGeneration: 1,
    budgetRevision: "budget_1",
  };
}

function eventInput(
  sequence: number,
  eventDigest: string,
  payload: string,
  envelopeTurnId = "turn_1",
) {
  const lease = harnessLease();
  return {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence,
    eventDigest,
    payload: JSON.stringify({
      turnId: envelopeTurnId,
      sequence,
      emittedAt: 10 + sequence,
      event: { type: "agent_message", text: payload, finalMessage: false },
    }),
    acceptedAt: 10 + sequence,
  };
}

function historyInput(
  lease: HarnessTurnLease,
  sequence: number,
  previousDigest: string | null,
  text: string,
) {
  return historyInputWithContent(
    lease,
    sequence,
    previousDigest,
    [{ kind: "text", text }],
    initialEntryInput(lease),
  );
}

function historyInputWithContent(
  lease: HarnessTurnLease,
  sequence: number,
  previousDigest: string | null,
  content: readonly HarnessHistoryContent[],
  input: AcceptedInputRef,
) {
  return {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence,
    previousDigest,
    entry: {
      kind: "user_input" as const,
      turn: lease.turn,
      input,
      content: [...content],
      acceptedAt: 10 + sequence,
    },
    acceptedAt: 10 + sequence,
  };
}

function settledEffectCallInput(
  lease: HarnessTurnLease,
  sequence: number,
  previousDigest: string,
) {
  return {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence,
    previousDigest,
    entry: {
      kind: "assistant_message" as const,
      turn: lease.turn,
      content: [
        {
          kind: "tool_call" as const,
          callId: "tool_effect_crash_1",
          tool: "commerce_inventory_read",
          arguments: {},
          continuation: {
            kind: "opaque" as const,
            value: "response_effect_crash_1",
          },
        },
      ],
      model: "gpt-5.6-sol",
      stopReason: "tool_use" as const,
      usage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      acceptedAt: 12,
    },
    acceptedAt: 12,
  };
}

function settledEffectResultInput(
  lease: HarnessTurnLease,
  sequence: number,
  previousDigest: string,
) {
  return {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence,
    previousDigest,
    entry: {
      kind: "tool_result" as const,
      turn: lease.turn,
      callId: "tool_effect_crash_1",
      tool: "commerce_inventory_read",
      outcome: {
        kind: "succeeded" as const,
        output: {
          kind: "inline" as const,
          content: [{ kind: "text" as const, text: "8 units" }],
          digest: "8".repeat(64),
        },
      },
      authority: {
        kind: "provider_effect" as const,
        receiptId: "provider_receipt_crash_1",
        resultDigest: "8".repeat(64),
      },
      acceptedAt: 13,
    },
    acceptedAt: 13,
  };
}

function historyUserInput(
  turn: TurnIdentity,
  text: string,
  acceptedAt: number,
) {
  return {
    kind: "user_input" as const,
    turn,
    input: acceptedInputRef(turn),
    content: [{ kind: "text" as const, text }],
    acceptedAt,
  };
}

function initialEntryInput(lease: HarnessTurnLease): AcceptedInputRef {
  return acceptedInputRef(lease.turn);
}

function acceptedInputRef(turn: TurnIdentity): AcceptedInputRef {
  return {
    kind: "case",
    inputId: turn.inputId,
    caseId: "case_1",
    assignmentId: "assignment_1",
    caseRevision: 1,
    contentDigest: "c".repeat(64),
    workspaceRevision: "workspace_revision_1",
    contextBundleDigest: CONTEXT_BUNDLE_DIGEST,
  };
}

function checkpointRecord(
  cursor: Variant<HarnessEventCursor, "accepted">,
  backendId: CommitHarnessCheckpointInput["checkpoint"]["backendId"] = "pi",
  historyCursor = { lastSequence: 1, lastEntryDigest: "f".repeat(64) },
): CommitHarnessCheckpointInput["checkpoint"] {
  const lease = harnessLease();
  return {
    backendId,
    blob: {
      objectKey: `harness-checkpoints/organisation_1/session_1/turn_1/sequence-2/${"a".repeat(64)}.bin`,
      sha256: "a".repeat(64),
      byteLength: 256,
      formatVersion: "satyr-pi-durable-checkpoint-fixture-v1",
      harnessBuild: "pi-durable-fixture",
      createdAt: 13,
    },
    session: lease.session,
    turn: lease.turn,
    runtimeLease: lease.runtimeLease,
    runtimeRevision: lease.runtimeRevision,
    policyVersion: "policy_1",
    budgetRevision: lease.turn.budgetRevision,
    budgetUsage: { tokens: 100, activeWallMs: 10, capabilityCalls: 1 },
    usageCursor: 3,
    budgetAccountDigest: "d".repeat(64),
    cursor,
    historyCursor,
    lastActorEventSequence: 4,
    workspaceBaseRevision: "workspace_1",
    workspaceRevision: "workspace_1",
    instructionDigest: "b".repeat(64),
    toolCatalogDigest: "c".repeat(64),
    modelRouteDigest: MODEL_ROUTE_DIGEST,
  };
}
