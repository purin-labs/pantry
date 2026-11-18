/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  acceptConnectorCaseWork,
  claimConnectorCaseWork,
  createConnectorCaseWorkSchema,
  finalizeConnectorCaseWork,
  nextConnectorCaseWorkAlarm,
  type ConnectorCaseWorkRequest,
} from "../src/actors/connector-case-work";
import {
  appendHarnessHistory,
  createSessionHarnessAuthoritySchema,
  readHarnessHistory,
  type AppendHarnessHistoryInput,
  type HarnessAuthorityStorage,
} from "../src/actors/agent-session-harness-authority";
import { createSessionSchema } from "../src/actors/agent-session-schema";
import { readSessionTurnReplay } from "../src/actors/agent-session-turn-stream";
import {
  digestPersistedHarnessHistoryEnvelope,
  encodeHarnessHistoryEntry,
  type HarnessHistoryEntry,
} from "../src/actors/harness-history";
import { parsePersonId } from "../src/data/person-authz";
import {
  parseAssignmentId,
  parseCaseId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "../src/ids";
import { createSlackCaseCommand } from "../src/ingress-queue";
import { parseOrganisationPlacement } from "../src/placement";
import { parseSlackEnvelope } from "../src/slack/events";
import { isRecord } from "@seams/std";
import { requireOrganisationId } from "./test-ids";

type BenchmarkProfile = "smoke" | "quick" | "full";

type BenchmarkSample = {
  readonly area:
    "connector" | "history_append" | "restore" | "replay" | "actor_scaling";
  readonly operation: string;
  readonly scale: string;
  readonly iteration: number;
  readonly durationMs: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly databaseBytesBefore: number;
  readonly databaseBytesAfter: number;
  readonly outcome: string;
  readonly measurements: Readonly<
    Record<string, number | string | boolean | null>
  >;
};

type BenchmarkOutput = {
  readonly schemaVersion: 1;
  readonly variant: string;
  readonly commit: string;
  readonly profile: BenchmarkProfile;
  readonly iteration: number;
  readonly generatedAt: string;
  readonly samples: readonly BenchmarkSample[];
  readonly invariants: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
};

type BenchmarkRow = Record<string, SqlStorageValue>;

class BenchmarkCursor<Row extends BenchmarkRow> {
  constructor(
    private readonly rows: readonly Row[],
    readonly rowsRead: number,
    readonly rowsWritten: number,
  ) {}

  *[Symbol.iterator](): IterableIterator<Row> {
    yield* this.rows;
  }

  toArray(): Row[] {
    return [...this.rows];
  }
}

class BenchmarkStorage implements HarnessAuthorityStorage {
  readonly sql: SqlStorage;
  private measuredRowsRead = 0;
  private measuredRowsWritten = 0;
  private seededHistoryRows = 0;

  constructor(readonly database: DatabaseSync) {
    this.sql = this as unknown as SqlStorage;
  }

  exec<Row extends BenchmarkRow>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): BenchmarkCursor<Row> {
    const statement = this.database.prepare(query);
    const values = bindings.map(sqliteBinding);
    if (isReadQuery(query) || hasReturningClause(query)) {
      const rows = statement.all(...values) as Row[];
      const rowsRead = this.estimateRowsRead(query, rows.length);
      this.measuredRowsRead += rowsRead;
      return new BenchmarkCursor(rows, rowsRead, 0);
    }
    const result = statement.run(...values);
    const rowsWritten = Number(result.changes);
    this.measuredRowsWritten += rowsWritten;
    return new BenchmarkCursor<Row>([], 0, rowsWritten);
  }

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setSeededHistoryRows(rows: number): void {
    this.seededHistoryRows = rows;
  }

  resetMetrics(): void {
    this.measuredRowsRead = 0;
    this.measuredRowsWritten = 0;
  }

  metrics(): { readonly rowsRead: number; readonly rowsWritten: number } {
    return {
      rowsRead: this.measuredRowsRead,
      rowsWritten: this.measuredRowsWritten,
    };
  }

  databaseBytes(): number {
    const pageCount = numericPragma(this.database, "page_count");
    const pageSize = numericPragma(this.database, "page_size");
    return pageCount * pageSize;
  }

  close(): void {
    this.database.close();
  }

  private estimateRowsRead(query: string, returnedRows: number): number {
    if (
      this.seededHistoryRows > 0 &&
      query.includes("FROM session_harness_history") &&
      (query.includes("COUNT(*)") || query.includes("SUM(byte_length)"))
    ) {
      return this.seededHistoryRows;
    }
    if (
      this.seededHistoryRows > 0 &&
      query.includes("WHERE session_id = ? AND turn_id = ?") &&
      !tableHasIndex(this.database, "session_harness_history_turn")
    ) {
      return this.seededHistoryRows;
    }
    return returnedRows;
  }
}

class HeapSampler {
  private readonly startingBytes = process.memoryUsage().heapUsed;
  private peakBytes = this.startingBytes;
  private readonly timer = setInterval(this.record.bind(this), 1);

  stop(): number {
    clearInterval(this.timer);
    this.record();
    return Math.max(0, this.peakBytes - this.startingBytes);
  }

  private record(): void {
    this.peakBytes = Math.max(this.peakBytes, process.memoryUsage().heapUsed);
  }
}

const enabled = process.env.SATYR_OPTIMIZATION_BENCHMARK === "1";

describe.skipIf(!enabled)(
  "optimization 1 benchmark",
  optimizationBenchmarkSuite,
);

function optimizationBenchmarkSuite(): void {
  it(
    "executes deterministic Durable Object storage workloads",
    executeBenchmark,
    120_000,
  );
}

async function executeBenchmark(): Promise<void> {
  const profile = benchmarkProfile(process.env.SATYR_BENCH_PROFILE);
  const iteration = integerEnvironment("SATYR_BENCH_ITERATION", 0);
  if (profile === "smoke") {
    await runSmokeChecks();
  }
  const samples =
    profile === "smoke" ? [] : await runWorkloads(profile, iteration);
  const output: BenchmarkOutput = {
    schemaVersion: 1,
    variant: process.env.SATYR_BENCH_VARIANT ?? "candidate",
    commit: process.env.SATYR_BENCH_COMMIT ?? "working-tree",
    profile,
    iteration,
    generatedAt: new Date().toISOString(),
    samples,
    invariants: [
      { name: "valid_workload_operations_succeeded", passed: true },
      { name: "fresh_database_per_measured_sample", passed: true },
    ],
  };
  const outputPath = process.env.SATYR_BENCH_OUTPUT;
  if (outputPath !== undefined)
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

async function runWorkloads(
  profile: Exclude<BenchmarkProfile, "smoke">,
  iteration: number,
): Promise<BenchmarkSample[]> {
  const samples: BenchmarkSample[] = [];
  const terminalCounts =
    profile === "full" ? [0, 1_000, 10_000, 100_000] : [0, 1_000, 10_000];
  const priorHistoryCounts =
    profile === "full" ? [0, 1_000, 10_000, 99_999] : [0, 1_000, 10_000];
  const restoreTargets =
    profile === "full"
      ? [
          0,
          1 * 1024 * 1024,
          8 * 1024 * 1024,
          16 * 1024 * 1024,
          16 * 1024 * 1024 + 1,
        ]
      : [0, 1 * 1024 * 1024, 16 * 1024 * 1024 + 1];

  for (const count of terminalCounts) {
    runConnectorClaimSample(count, -1);
    samples.push(runConnectorClaimSample(count, iteration));
    runConnectorAlarmSample(count, -1);
    samples.push(runConnectorAlarmSample(count, iteration));
  }
  for (const count of priorHistoryCounts) {
    await runHistoryAppendSample(count, -1);
    samples.push(await runHistoryAppendSample(count, iteration));
  }
  if (profile === "full") {
    await runHistoryEntryLimitSample(-1);
    samples.push(await runHistoryEntryLimitSample(iteration));
  }
  for (const targetBytes of restoreTargets) {
    await runRestoreSample(targetBytes, -1);
    samples.push(await runRestoreSample(targetBytes, iteration));
  }
  runReplaySample("short", 5, -1);
  samples.push(runReplaySample("short", 5, iteration));
  runReplaySample("bursty", 100, -1);
  samples.push(runReplaySample("bursty", 100, iteration));
  runReplaySample("long", 1_000, -1);
  samples.push(runReplaySample("long", 1_000, iteration));
  runReplaySample("idle", 0, -1);
  samples.push(runReplaySample("idle", 0, iteration));
  runActorScalingSample(1, -1);
  samples.push(runActorScalingSample(1, iteration));
  runActorScalingSample(profile === "full" ? 100 : 25, -1);
  samples.push(runActorScalingSample(profile === "full" ? 100 : 25, iteration));
  return samples;
}

function runConnectorClaimSample(
  terminalCount: number,
  iteration: number,
): BenchmarkSample {
  const fixture = connectorFixture(terminalCount, true);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const startedAt = performance.now();
  const raw = claimConnectorCaseWork(
    fixture.storage.sql,
    terminalCount + 1_000,
  );
  const durationMs = performance.now() - startedAt;
  const claim = connectorClaim(raw);
  const metrics = fixture.storage.metrics();
  expect(claim).not.toBeNull();
  const resultSample = benchmarkSample({
    area: "connector",
    operation: "claim_due_work",
    scale: `${terminalCount}_terminal_records`,
    iteration,
    durationMs,
    rowsRead: connectorReportedRows(raw) ?? metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: "claimed",
    measurements: { terminalCount, storageEstimatedRowsRead: metrics.rowsRead },
  });
  fixture.storage.close();
  return resultSample;
}

function runConnectorAlarmSample(
  terminalCount: number,
  iteration: number,
): BenchmarkSample {
  const fixture = connectorFixture(terminalCount, true);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const startedAt = performance.now();
  const raw = nextConnectorCaseWorkAlarm(fixture.storage.sql);
  const durationMs = performance.now() - startedAt;
  const metrics = fixture.storage.metrics();
  const alarm = connectorAlarm(raw);
  expect(alarm).toBe(terminalCount + 1_000);
  const resultSample = benchmarkSample({
    area: "connector",
    operation: "calculate_next_alarm",
    scale: `${terminalCount}_terminal_records`,
    iteration,
    durationMs,
    rowsRead: connectorReportedRows(raw) ?? metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: "alarm_found",
    measurements: { terminalCount, storageEstimatedRowsRead: metrics.rowsRead },
  });
  fixture.storage.close();
  return resultSample;
}

async function runHistoryAppendSample(
  priorEntries: number,
  iteration: number,
): Promise<BenchmarkSample> {
  const fixture = await historyAppendFixture(priorEntries);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const startedAt = performance.now();
  const result = await appendHarnessHistory(fixture.storage, fixture.input);
  const durationMs = performance.now() - startedAt;
  const metrics = fixture.storage.metrics();
  expect(result.ok).toBe(true);
  const usage = result.ok ? result.value.usage.entryCount : -1;
  expect(usage).toBe(priorEntries + 1);
  const resultSample = benchmarkSample({
    area: "history_append",
    operation: "accepted_append",
    scale: `${priorEntries}_prior_entries`,
    iteration,
    durationMs,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: result.ok ? result.value.kind : result.error.code,
    measurements: { priorEntries, authoritativeUsage: usage },
  });
  fixture.storage.close();
  return resultSample;
}

async function runHistoryEntryLimitSample(
  iteration: number,
): Promise<BenchmarkSample> {
  const priorEntries = 100_000;
  const fixture = await historyAppendFixture(priorEntries);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const startedAt = performance.now();
  const result = await appendHarnessHistory(fixture.storage, fixture.input);
  const durationMs = performance.now() - startedAt;
  const metrics = fixture.storage.metrics();
  expect(result).toMatchObject({
    ok: false,
    error: { code: "harness_history_budget_exceeded", limit: "entry_count" },
  });
  const resultSample = benchmarkSample({
    area: "history_append",
    operation: "entry_limit_rejection",
    scale: "100000_prior_entries",
    iteration,
    durationMs,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: result.ok ? result.value.kind : result.error.code,
    measurements: { priorEntries, usageUnchanged: true },
  });
  fixture.storage.close();
  return resultSample;
}

async function runRestoreSample(
  targetBytes: number,
  iteration: number,
): Promise<BenchmarkSample> {
  const fixture = await restoreFixture(targetBytes);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const heapSampler = new HeapSampler();
  const startedAt = performance.now();
  const result = await readHarnessHistory(
    fixture.storage.sql,
    fixture.sessionId,
    fixture.organisationId,
  );
  const durationMs = performance.now() - startedAt;
  const peakHeapDeltaBytes = heapSampler.stop();
  const metrics = fixture.storage.metrics();
  expect(result.ok).toBe(true);
  const restored = restoreOutcome(result);
  const resultSample = benchmarkSample({
    area: "restore",
    operation: "fresh_restore",
    scale: restoreScale(targetBytes),
    iteration,
    durationMs,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: restored.kind,
    measurements: {
      targetBytes,
      encodedBytes: fixture.encodedBytes,
      seededEntries: fixture.entryCount,
      materializedEntries: restored.entries,
      peakHeapDeltaBytes,
      memoryMeasurement: "sampled_1ms",
    },
  });
  fixture.storage.close();
  return resultSample;
}

function runReplaySample(
  shape: string,
  eventCount: number,
  iteration: number,
): BenchmarkSample {
  const fixture = replayFixture(eventCount);
  const before = fixture.storage.databaseBytes();
  fixture.storage.resetMetrics();
  const startedAt = performance.now();
  let cursor = -1;
  let polls = 0;
  let returnedRows = 0;
  let caughtUp = false;
  while (!caughtUp) {
    const replay = readSessionTurnReplay(fixture.storage.sql, {
      turnId: fixture.turnId,
      organisationId: fixture.organisationId,
      afterSequence: cursor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) break;
    polls += 1;
    returnedRows += replay.value.envelopes.length;
    caughtUp = replay.value.caughtUp;
    const last = replay.value.envelopes.at(-1);
    if (last !== undefined) cursor = last.sequence;
  }
  const durationMs = performance.now() - startedAt;
  const metrics = fixture.storage.metrics();
  expect(returnedRows).toBe(eventCount);
  const resultSample = benchmarkSample({
    area: "replay",
    operation: "replay_to_cursor",
    scale: shape,
    iteration,
    durationMs,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    databaseBytesBefore: before,
    databaseBytesAfter: fixture.storage.databaseBytes(),
    outcome: "caught_up",
    measurements: {
      eventCount,
      polls,
      emptyPolls: eventCount === 0 ? 1 : 0,
      returnedRows,
      configuredPollIntervalMs: 50,
    },
  });
  fixture.storage.close();
  return resultSample;
}

function runActorScalingSample(
  actorCount: number,
  iteration: number,
): BenchmarkSample {
  const fixtures: ConnectorFixture[] = [];
  for (let index = 0; index < actorCount; index += 1)
    fixtures.push(connectorFixture(0, true));
  const startedAt = performance.now();
  let rowsRead = 0;
  let rowsWritten = 0;
  for (const fixture of fixtures) {
    fixture.storage.resetMetrics();
    const result = claimConnectorCaseWork(fixture.storage.sql, 1_000);
    expect(connectorClaim(result)).not.toBeNull();
    const metrics = fixture.storage.metrics();
    rowsRead += connectorReportedRows(result) ?? metrics.rowsRead;
    rowsWritten += metrics.rowsWritten;
  }
  const durationMs = performance.now() - startedAt;
  for (const fixture of fixtures) fixture.storage.close();
  return benchmarkSample({
    area: "actor_scaling",
    operation: "independent_actor_claims",
    scale: `${actorCount}_actors`,
    iteration,
    durationMs,
    rowsRead,
    rowsWritten,
    databaseBytesBefore: 0,
    databaseBytesAfter: 0,
    outcome: "all_claimed",
    measurements: {
      actorCount,
      operationsPerSecond: actorCount / (durationMs / 1_000),
      executionModel: "isolated_sqlite_batch",
    },
  });
}

async function runSmokeChecks(): Promise<void> {
  const connector = connectorFixture(1_000, true);
  connector.storage.resetMetrics();
  const claim = claimConnectorCaseWork(connector.storage.sql, 2_000);
  expect(connectorClaim(claim)).not.toBeNull();
  expect(connectorReportedRows(claim)).toBeLessThanOrEqual(1);
  expect(
    queryPlanUses(connector.storage.database, "connector_case_work_due", [
      "SELECT event_id, payload, state_kind, attempt, due_at, retry_reason, created_at",
      "FROM connector_case_work WHERE due_at <= 2000 ORDER BY due_at, created_at LIMIT 1",
    ]),
  ).toBe(true);
  connector.storage.close();

  const history = await historyAppendFixture(10);
  const append = await appendHarnessHistory(history.storage, history.input);
  expect(append.ok).toBe(true);
  const usage = history.storage.database
    .prepare(
      "SELECT entry_count, through_sequence FROM session_harness_usage WHERE session_id = ?",
    )
    .get(history.input.sessionId);
  expect(usage).toMatchObject({ entry_count: 11, through_sequence: 11 });
  expect(
    tableHasIndex(history.storage.database, "session_harness_history_turn"),
  ).toBe(true);
  history.storage.close();

  const oversized = new BenchmarkStorage(new DatabaseSync(":memory:"));
  createSessionHarnessAuthoritySchema(oversized.sql);
  oversized.database
    .prepare(
      `INSERT INTO session_harness_usage (
       session_id, organisation_id, entry_count, inline_byte_count, through_sequence
     ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "session_oversized",
      "organisation_oversized",
      1,
      16 * 1024 * 1024 + 1,
      1,
    );
  oversized.setSeededHistoryRows(1);
  oversized.resetMetrics();
  const restore = await readHarnessHistory(
    oversized.sql,
    "session_oversized",
    "organisation_oversized",
  );
  expect(restore).toMatchObject({
    ok: true,
    value: { kind: "history_materialization_limit" },
  });
  expect(oversized.metrics().rowsRead).toBe(1);
  oversized.close();
}

type ConnectorFixture = {
  readonly storage: BenchmarkStorage;
  readonly request: ConnectorCaseWorkRequest;
};

function connectorFixture(
  terminalCount: number,
  active: boolean,
): ConnectorFixture {
  const storage = new BenchmarkStorage(new DatabaseSync(":memory:"));
  createConnectorCaseWorkSchema(storage.sql);
  seedSettledConnectorWork(storage.sql, terminalCount);
  const request = caseWorkRequest(terminalCount + 1_000);
  if (active) {
    const accepted = acceptConnectorCaseWork(storage.sql, request);
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.value.kind).toBe("accepted");
  }
  storage.resetMetrics();
  return { storage, request };
}

/**
 * Settles `count` messages through the Connector's own accept, claim and
 * finalize steps, so each leaves one completed receipt.
 */
function seedSettledConnectorWork(sql: SqlStorage, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const accepted = acceptConnectorCaseWork(sql, caseWorkRequest(index + 1));
    if (!accepted.ok || accepted.value.kind !== "accepted")
      throw new Error("The seed message was not accepted");
    const claimed = claimConnectorCaseWork(sql, index + 1);
    if (!claimed.ok || claimed.value.result === null)
      throw new Error("The seed message was not claimed");
    const settled = finalizeConnectorCaseWork(sql, claimed.value.result, {
      kind: "completed",
      completedAt: index + 1,
    });
    if (!settled.ok) throw new Error(settled.error.code);
  }
}

function caseWorkRequest(receivedAt: number): ConnectorCaseWorkRequest {
  const messageTs = `1785700000.${String(receivedAt).padStart(6, "0")}`;
  const organisationId = parseOrganisationId("organisation_case_work");
  const caseId = parseCaseId("case_case_work");
  const connectorId = parseConnectorId("connector_case_work");
  const assignmentId = parseAssignmentId("assignment_case_work");
  const requestId = parseRequestId("request_case_work");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_case_work",
  );
  const principalId = parsePersonId("person_case-work");
  const placement = parseOrganisationPlacement(
    {
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "test",
      locationHint: "wnam",
    },
    "test.placement",
  );
  const envelope = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: `Ev_case_work_${receivedAt}`,
      team_id: "T0CASEWORK",
      event: {
        type: "app_mention",
        channel: "C0CASEWORK",
        user: "U0CASEWORK",
        ts: messageTs,
        event_ts: messageTs,
        text: "work",
      },
    }),
  );
  if (
    !organisationId.ok ||
    !caseId.ok ||
    !connectorId.ok ||
    !assignmentId.ok ||
    !requestId.ok ||
    !integrationAccountId.ok ||
    principalId === null ||
    !placement.ok ||
    !envelope.ok ||
    envelope.value.kind !== "message"
  )
    throw new Error("connector benchmark fixture invalid");
  return {
    identity: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
    },
    command: createSlackCaseCommand({
      requestId: requestId.value,
      receivedAt,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      principalId,
      userId: null,
      requestAuthority: {
        kind: "shared_conversation",
        organisationId: organisationId.value,
        requesterPersonId: principalId,
        membershipRevision: 1,
        role: "operator",
        connectorId: connectorId.value,
        integrationAccountId: integrationAccountId.value,
        conversationId: envelope.value.event.channelId,
      },
      event: envelope.value.event,
      target: {
        caseId: caseId.value,
        connectorId: connectorId.value,
        sessionId: envelope.value.event.sessionId,
        assignmentId: assignmentId.value,
        placement: placement.value,
      },
    }),
  };
}

async function historyAppendFixture(priorEntries: number): Promise<{
  readonly storage: BenchmarkStorage;
  readonly input: AppendHarnessHistoryInput;
}> {
  const storage = new BenchmarkStorage(new DatabaseSync(":memory:"));
  createSessionHarnessAuthoritySchema(storage.sql);
  const organisationId = "organisation_history_benchmark";
  const sessionId = "session_history_benchmark";
  const leaseId = "lease_history_benchmark";
  const turn = benchmarkTurn("turn_current");
  const previousDigest =
    priorEntries === 0
      ? null
      : await digestPersistedHarnessHistoryEnvelope({
          sessionId,
          sequence: 1,
          previousDigest: null,
          envelope: {},
        });
  seedHistoryRows(storage.database, {
    organisationId,
    sessionId,
    turnId: "turn_completed",
    count: priorEntries,
    payload: "{}",
    digest: previousDigest ?? "a".repeat(64),
  });
  seedUsageIfPresent(
    storage.database,
    organisationId,
    sessionId,
    priorEntries,
    priorEntries * 2,
  );
  storage.database
    .prepare(
      `INSERT INTO session_harness_lease (
       session_id, organisation_id, lease_id, turn_id, turn_projection, lease_projection,
       last_sequence, last_event_digest, history_sequence, history_digest,
       issued_at, expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, 999999999, 0)`,
    )
    .run(
      sessionId,
      organisationId,
      leaseId,
      turn.turnId,
      JSON.stringify(turn),
      "{}",
      priorEntries === 0 ? null : priorEntries,
      previousDigest,
    );
  storage.setSeededHistoryRows(priorEntries);
  const input: AppendHarnessHistoryInput = {
    leaseId,
    sessionId,
    turn,
    sequence: priorEntries + 1,
    previousDigest,
    entry: historyUserInput(turn, "benchmark append", priorEntries + 1),
    acceptedAt: priorEntries + 1,
  };
  return { storage, input };
}

async function restoreFixture(targetBytes: number): Promise<{
  readonly storage: BenchmarkStorage;
  readonly sessionId: string;
  readonly organisationId: string;
  readonly encodedBytes: number;
  readonly entryCount: number;
}> {
  const storage = new BenchmarkStorage(new DatabaseSync(":memory:"));
  createSessionHarnessAuthoritySchema(storage.sql);
  const organisationId = "organisation_restore_benchmark";
  const sessionId = "session_restore_benchmark";
  if (targetBytes === 0)
    return {
      storage,
      sessionId,
      organisationId,
      encodedBytes: 0,
      entryCount: 0,
    };
  const turn = benchmarkTurn("turn_restore");
  const entry = historyUserInput(turn, "x".repeat(3_600), 1);
  const payload = encodeHarnessHistoryEntry(entry);
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  const materializationLimit = 16 * 1024 * 1024;
  const oversized = targetBytes > materializationLimit;
  const entryCount = oversized
    ? Math.floor(materializationLimit / payloadBytes) + 1
    : Math.max(1, Math.floor(targetBytes / payloadBytes));
  const encodedBytes = entryCount * payloadBytes;
  let previousDigest: Awaited<
    ReturnType<typeof digestPersistedHarnessHistoryEnvelope>
  > | null = null;
  const insert = storage.database.prepare(
    `INSERT INTO session_harness_history (
       organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
       payload, byte_length, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  storage.database.exec("BEGIN IMMEDIATE");
  try {
    const envelope: unknown = JSON.parse(payload);
    for (let sequence = 1; sequence <= entryCount; sequence += 1) {
      const digest = await digestPersistedHarnessHistoryEnvelope({
        sessionId,
        sequence,
        previousDigest,
        envelope,
      });
      insert.run(
        organisationId,
        sessionId,
        turn.turnId,
        sequence,
        previousDigest,
        digest,
        payload,
        payloadBytes,
        sequence,
      );
      previousDigest = digest;
    }
    storage.database.exec("COMMIT");
  } catch (error) {
    storage.database.exec("ROLLBACK");
    throw error;
  }
  seedUsageIfPresent(
    storage.database,
    organisationId,
    sessionId,
    entryCount,
    encodedBytes,
  );
  storage.setSeededHistoryRows(entryCount);
  return { storage, sessionId, organisationId, encodedBytes, entryCount };
}

function seedHistoryRows(
  database: DatabaseSync,
  input: {
    readonly organisationId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly count: number;
    readonly payload: string;
    readonly digest: string;
  },
): void {
  if (input.count === 0) return;
  const insert = database.prepare(
    `INSERT INTO session_harness_history (
       organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
       payload, byte_length, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let sequence = 1; sequence <= input.count; sequence += 1) {
      insert.run(
        input.organisationId,
        input.sessionId,
        input.turnId,
        sequence,
        sequence === 1 ? null : input.digest,
        input.digest,
        input.payload,
        new TextEncoder().encode(input.payload).byteLength,
        sequence,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedUsageIfPresent(
  database: DatabaseSync,
  organisationId: string,
  sessionId: string,
  entryCount: number,
  inlineBytes: number,
): void {
  if (entryCount === 0 || !tableExists(database, "session_harness_usage"))
    return;
  database
    .prepare(
      `INSERT INTO session_harness_usage (
       session_id, organisation_id, entry_count, inline_byte_count, through_sequence
     ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, organisationId, entryCount, inlineBytes, entryCount);
}

function replayFixture(eventCount: number): {
  readonly storage: BenchmarkStorage;
  readonly turnId: string;
  readonly organisationId: ReturnType<typeof requireOrganisationId>;
} {
  const storage = new BenchmarkStorage(new DatabaseSync(":memory:"));
  createSessionSchema(storage.sql);
  const turnId = "turn_replay_benchmark";
  const organisationId = requireOrganisationId("organisation_replay_benchmark");
  const requestId = "request_replay_benchmark";
  storage.database
    .prepare(
      `INSERT INTO session_turn_stream (
       turn_id, request_id, organisation_id, input_digest, state, last_sequence,
       error_detail, started_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, NULL, 0, ?)`,
    )
    .run(
      turnId,
      requestId,
      organisationId,
      eventCount === 0 ? "running" : "complete",
      eventCount - 1,
      eventCount,
    );
  const insert = storage.database.prepare(
    `INSERT INTO session_event (
       organisation_id, request_id, kind, payload, at, archived, turn_id, turn_sequence
     ) VALUES (?, ?, 'agent_message', ?, ?, 0, ?, ?)`,
  );
  storage.database.exec("BEGIN IMMEDIATE");
  try {
    for (let sequence = 0; sequence < eventCount; sequence += 1) {
      insert.run(
        organisationId,
        requestId,
        JSON.stringify({
          type: "agent_message",
          text: `event ${sequence}`,
          finalMessage: false,
        }),
        sequence,
        turnId,
        sequence,
      );
    }
    storage.database.exec("COMMIT");
  } catch (error) {
    storage.database.exec("ROLLBACK");
    throw error;
  }
  return { storage, turnId, organisationId };
}

function benchmarkTurn(turnId: string) {
  return {
    turnId,
    inputId: `input_${turnId}`,
    turnLeaseGeneration: 1,
    budgetRevision: "budget_benchmark",
  };
}

function historyUserInput(
  turn: ReturnType<typeof benchmarkTurn>,
  text: string,
  acceptedAt: number,
): HarnessHistoryEntry {
  return {
    kind: "user_input",
    turn,
    input: {
      kind: "case",
      inputId: turn.inputId,
      caseId: "case_benchmark",
      assignmentId: "assignment_benchmark",
      caseRevision: 1,
      contentDigest: "c".repeat(64),
      workspaceRevision: "workspace_benchmark",
      contextBundleDigest: "d".repeat(64),
    },
    content: [{ kind: "text", text }],
    acceptedAt,
  };
}

function connectorClaim(
  raw: ReturnType<typeof claimConnectorCaseWork>,
): { readonly attempt: number } | null {
  if (!raw.ok) throw new Error(raw.error.code);
  const value: unknown = raw.value;
  if (isRecord(value) && Object.hasOwn(value, "result")) {
    const result = value.result;
    return normalizedClaim(result);
  }
  return normalizedClaim(value);
}

function normalizedClaim(value: unknown): { readonly attempt: number } | null {
  if (value === null) return null;
  return isRecord(value) &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0
    ? { attempt: Number(value.attempt) }
    : null;
}

function connectorAlarm(
  raw: ReturnType<typeof nextConnectorCaseWorkAlarm>,
): number | null {
  const value: unknown = raw;
  if (isRecord(value) && Object.hasOwn(value, "result")) {
    return typeof value.result === "number" ? value.result : null;
  }
  return typeof value === "number" ? value : null;
}

function connectorReportedRows(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.rowsRead === "number") return raw.rowsRead;
  if (isRecord(raw.value) && typeof raw.value.rowsRead === "number")
    return raw.value.rowsRead;
  return null;
}

function restoreOutcome(
  result: Awaited<ReturnType<typeof readHarnessHistory>>,
): {
  readonly kind: string;
  readonly entries: number;
} {
  if (!result.ok) return { kind: result.error.code, entries: 0 };
  const value: unknown = result.value;
  if (isRecord(value) && value.kind === "history_materialization_limit") {
    return { kind: value.kind, entries: 0 };
  }
  if (
    isRecord(value) &&
    (value.kind === "empty" || value.kind === "bounded_history")
  ) {
    const history = value.history;
    return {
      kind: String(value.kind),
      entries:
        isRecord(history) && Array.isArray(history.entries)
          ? history.entries.length
          : 0,
    };
  }
  return {
    kind: "legacy_history",
    entries:
      isRecord(value) && Array.isArray(value.entries)
        ? value.entries.length
        : 0,
  };
}

function benchmarkSample(input: BenchmarkSample): BenchmarkSample {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0)
    throw new Error("invalid benchmark duration");
  return input;
}

function restoreScale(bytes: number): string {
  if (bytes === 0) return "0_bytes";
  if (bytes > 16 * 1024 * 1024) return "over_16_mib";
  return `${bytes / (1024 * 1024)}_mib`;
}

function benchmarkProfile(value: string | undefined): BenchmarkProfile {
  if (value === "smoke" || value === "quick" || value === "full") return value;
  return "quick";
}

function integerEnvironment(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function numericPragma(
  database: DatabaseSync,
  name: "page_count" | "page_size",
): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = row?.[name];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function queryPlanUses(
  database: DatabaseSync,
  index: string,
  queryLines: readonly string[],
): boolean {
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${queryLines.join(" ")}`)
    .all();
  return rows.some(planRowIncludes.bind(null, index));
}

function planRowIncludes(index: string, row: Record<string, unknown>): boolean {
  return typeof row.detail === "string" && row.detail.includes(index);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.present === 1
  );
}

function tableHasIndex(database: DatabaseSync, index: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(index)?.present === 1
  );
}

function isReadQuery(query: string): boolean {
  const operation = query.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
  return (
    operation === "SELECT" ||
    operation === "PRAGMA" ||
    operation === "WITH" ||
    operation === "EXPLAIN"
  );
}

function hasReturningClause(query: string): boolean {
  return /\bRETURNING\b/i.test(query);
}

function sqliteBinding(value: SqlStorageValue): SQLInputValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
