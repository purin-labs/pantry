import type { CobotTask } from "@purin-labs/control-api";
import type { BakeRunHold } from "@purin-labs/kitchen-control-api";
import type {
  BakeRunInput,
  PhysicalRun,
} from "@purin-labs/production-simulation/physical";
import {
  assertRequiredColumns,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "../../actors/schema-migrations";
import type { BakeDecidedVia, BakeDeciderRole } from "./records";

/**
 * The storage of one bake run's Durable Object (Plan 24 S4): one row with the
 * engine state, and one action record for each dispatch. Every value is the
 * plain JSON of the physical execution adapter, so the run reads back exactly
 * what it wrote.
 */

export type BakeRunDevice = Readonly<{
  deviceId: string;
  gatewayId: string;
  locationId: string;
  sourceKey: string;
  name: string;
  role: "cobot" | "oven";
}>;

/** Who approved the run: one approval covers the run (D1). */
export type BakeRunApproval = Readonly<{
  by: string;
  role: BakeDeciderRole;
  via: BakeDecidedVia;
  at: number;
}>;

type ActiveRunState = "running" | "paused" | "held" | "completed" | "stopped";

export type StoredBakeRun = Readonly<{
  organisationId: string;
  runId: string;
  proposalId: string;
  productName: string;
  state: ActiveRunState;
  input: BakeRunInput;
  devices: readonly BakeRunDevice[];
  approval: BakeRunApproval;
  physical: PhysicalRun;
  hold: BakeRunHold | null;
  /** The devices that this run paused, which its resume resumes. */
  pausedDevices: readonly string[];
  /** The last time a signal of the run's devices arrived. */
  lastEvidenceAt: number;
  startedAt: number;
  endedAt: number | null;
}>;

export type BakeRunActionState = "written" | "refused" | "sent" | "unsent";

/** The record of one dispatch, written before the task is sent. */
export type BakeRunAction = Readonly<{
  requestId: string;
  step: string;
  deviceId: string;
  sourceKey: string;
  task: CobotTask;
  approval: BakeRunApproval;
  state: BakeRunActionState;
  writtenAt: number;
  sentAt: number | null;
}>;

const SCHEMA: SchemaMigrationPlan = {
  key: "bake_run",
  currentVersion: 1,
  preservedTables: ["bake_run_state", "bake_run_action"],
  baseline: {
    version: 1,
    apply: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS bake_run_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        run_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      sql.exec(`CREATE TABLE IF NOT EXISTS bake_run_action (
        request_id TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        device_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        task_json TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('written', 'refused', 'sent', 'unsent')),
        written_at INTEGER NOT NULL,
        sent_at INTEGER
      )`);
    },
    validate: (sql) => {
      assertRequiredColumns(sql, "bake_run_state", [
        "singleton",
        "run_json",
        "updated_at",
      ]);
      assertRequiredColumns(sql, "bake_run_action", [
        "request_id",
        "step",
        "device_id",
        "source_key",
        "task_json",
        "approval_json",
        "state",
        "written_at",
        "sent_at",
      ]);
    },
  },
  steps: [],
};

export function runBakeRunSchemaMigrations(
  storage: DurableObjectStorage,
): void {
  runSchemaMigrations(storage.sql, SCHEMA, (operation) =>
    storage.transactionSync(operation),
  );
}

export function loadBakeRun(sql: SqlStorage): StoredBakeRun | null {
  const row = sql
    .exec<{ run_json: string }>(
      "SELECT run_json FROM bake_run_state WHERE singleton = 1",
    )
    .toArray()[0];
  return row === undefined ? null : (JSON.parse(row.run_json) as StoredBakeRun);
}

export function saveBakeRun(
  sql: SqlStorage,
  run: StoredBakeRun,
  now: number,
): void {
  sql.exec(
    `INSERT INTO bake_run_state (singleton, run_json, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT (singleton) DO UPDATE SET
       run_json = excluded.run_json, updated_at = excluded.updated_at`,
    JSON.stringify(run),
    now,
  );
}

type ActionRow = Readonly<{
  request_id: string;
  step: string;
  device_id: string;
  source_key: string;
  task_json: string;
  approval_json: string;
  state: BakeRunActionState;
  written_at: number;
  sent_at: number | null;
}>;

function actionOf(row: ActionRow): BakeRunAction {
  return {
    requestId: row.request_id,
    step: row.step,
    deviceId: row.device_id,
    sourceKey: row.source_key,
    task: JSON.parse(row.task_json) as CobotTask,
    approval: JSON.parse(row.approval_json) as BakeRunApproval,
    state: row.state,
    writtenAt: row.written_at,
    sentAt: row.sent_at,
  };
}

export function listBakeRunActions(sql: SqlStorage): readonly BakeRunAction[] {
  return sql
    .exec<ActionRow>(
      "SELECT * FROM bake_run_action ORDER BY written_at, request_id",
    )
    .toArray()
    .map(actionOf);
}

/** Writes the action record before the send. A known identity keeps its row. */
export function writeBakeRunAction(
  sql: SqlStorage,
  action: Omit<BakeRunAction, "state" | "sentAt">,
): void {
  sql.exec(
    `INSERT INTO bake_run_action (request_id, step, device_id, source_key,
       task_json, approval_json, state, written_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'written', ?, NULL)
     ON CONFLICT (request_id) DO NOTHING`,
    action.requestId,
    action.step,
    action.deviceId,
    action.sourceKey,
    JSON.stringify(action.task),
    JSON.stringify(action.approval),
    action.writtenAt,
  );
}

export function setBakeRunActionState(
  sql: SqlStorage,
  requestId: string,
  state: BakeRunActionState,
  now: number,
): void {
  sql.exec(
    `UPDATE bake_run_action SET state = ?,
       sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
      WHERE request_id = ? AND state != ?`,
    state,
    state,
    now,
    requestId,
    state,
  );
}
