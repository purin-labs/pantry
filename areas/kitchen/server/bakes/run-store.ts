import type { CobotObserved, CobotTask } from "@purin-labs/control-api";
import type {
  BakeAuthorityMode,
  BakeRunHold,
  BakeRunSettlement,
} from "@purin-labs/kitchen-control-api";
import type {
  BakeRunInput,
  PhysicalRun,
} from "@purin-labs/production-simulation/physical";
import {
  assertRequiredColumns,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "@purin-labs/actor-runtime/actors/schema-migrations";
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
  /** A shadow run (S5) watches its devices and sends them nothing. */
  mode: BakeAuthorityMode;
  state: ActiveRunState;
  input: BakeRunInput;
  devices: readonly BakeRunDevice[];
  approval: BakeRunApproval;
  physical: PhysicalRun;
  hold: BakeRunHold | null;
  /** The devices that this run paused, which its resume resumes. */
  pausedDevices: readonly string[];
  /**
   * When the run last started to wait for evidence: its start, a dispatch, a
   * resume or a settle. The watch counts silence from here or from the last
   * new line of the device, whichever is later.
   */
  lastEvidenceAt: number;
  /**
   * S6: the last sequence of each device that the run took in, and when it
   * rose. A repeated or stale line does not move it, so a frozen device
   * holds the run even while the gateway still sends its last clock.
   */
  progress: Readonly<
    Record<string, Readonly<{ sequence: number; at: number }>>
  >;
  /** A shadow run's observed moves, in the order of their arrival. */
  observed: readonly CobotObserved[];
  /**
   * S6: an unload that does not start this long after the bake ends shows
   * the over-bake risk. The recipe's step between the bake and the unload
   * gives it.
   */
  unloadGraceSeconds: number;
  /** The over-bake risk that the run found, once, and when it told Slack. */
  overBake: Readonly<{
    step: string;
    lateSeconds: number;
    detectedAt: number;
  }> | null;
  /** Each hold that a person settled, oldest first. */
  settlements: readonly BakeRunSettlement[];
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

/** S6: the revision of the run's Slack card, one up for each update. */
const CARD_TABLE = `CREATE TABLE IF NOT EXISTS bake_run_card (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL
)`;

const SCHEMA: SchemaMigrationPlan = {
  key: "bake_run",
  currentVersion: 1,
  preservedTables: ["bake_run_state", "bake_run_action", "bake_run_card"],
  baseline: {
    version: 1,
    apply: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS bake_run_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        run_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      sql.exec(CARD_TABLE);
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
      assertRequiredColumns(sql, "bake_run_card", ["singleton", "revision"]);
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
  // No bake run has been released, so the baseline holds every table.
  steps: [],
};

export function runBakeRunSchemaMigrations(
  storage: DurableObjectStorage,
): void {
  runSchemaMigrations(storage.sql, SCHEMA, (operation) =>
    storage.transactionSync(operation),
  );
}

/** The next revision of the run's Slack card. */
export function nextBakeRunCardRevision(sql: SqlStorage): number {
  const row = sql
    .exec<{ revision: number }>(
      `INSERT INTO bake_run_card (singleton, revision) VALUES (1, 1)
       ON CONFLICT (singleton) DO UPDATE SET revision = revision + 1
       RETURNING revision`,
    )
    .toArray()[0];
  return row?.revision ?? 1;
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
