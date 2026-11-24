import type { CobotReport, CobotTaskMessage } from "@purin-labs/control-api";
import type {
  CobotDispatchRecord,
  CobotDispatchState,
} from "@purin-labs/area-devices-contract/server/fleet-stub";

/**
 * The cobot dispatch ledger of one shop location inside DeviceFleetActor
 * (Plan 24 S4). A dispatch is one row from before its `cobot_task` is sent
 * until its run ends. A second dispatch with the same identity reads the row
 * and sends nothing, so no cobot makes one move twice. A lost socket turns
 * each open dispatch into `result_unknown`; the gateway's next hello asks its
 * state with `cobot_inquire`, never with `cobot_task`.
 *
 * A run watches its devices while it is active, so that the Actor knows which
 * run's Durable Object gets each report, clock, observed move and fault. The
 * Actor knows the run only by the id string of that Durable Object.
 *
 * An idle shop writes nothing here: a row starts with an approved bake run.
 */

/** The settled dispatches stay this long, for the run's record. */
const DISPATCH_RETENTION_MS = 30 * 24 * 60 * 60_000;

type DispatchRow = Readonly<{
  request_id: string;
  gateway_id: string;
  device_id: string;
  source_key: string;
  run_actor_id: string;
  run_id: string;
  task_id: string;
  message_json: string;
  state: CobotDispatchState;
  last_report_json: string | null;
  created_at: number;
  updated_at: number;
}>;

const OPEN_STATES = `('sent', 'accepted', 'running')`;

export function cobotDispatchSchemaStatements(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS cobot_dispatch (
       request_id TEXT PRIMARY KEY,
       gateway_id TEXT NOT NULL,
       device_id TEXT NOT NULL,
       source_key TEXT NOT NULL,
       run_actor_id TEXT NOT NULL,
       run_id TEXT NOT NULL,
       task_id TEXT NOT NULL,
       message_json TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN (
         'sent', 'unsent', 'accepted', 'running', 'completed', 'rejected',
         'indeterminate', 'result_unknown'
       )),
       last_report_json TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS cobot_dispatch_open
       ON cobot_dispatch (gateway_id, state)`,
    `CREATE TABLE IF NOT EXISTS cobot_run_watch (
       run_actor_id TEXT NOT NULL,
       gateway_id TEXT NOT NULL,
       source_key TEXT NOT NULL,
       PRIMARY KEY (run_actor_id, gateway_id, source_key)
     )`,
    // Each run that this location served, so that the Organisation's end
    // empties its Durable Object too. One row for each run.
    `CREATE TABLE IF NOT EXISTS cobot_run_known (
       run_actor_id TEXT PRIMARY KEY
     )`,
  ];
}

const COLUMNS = `request_id, gateway_id, device_id, source_key, run_actor_id,
  run_id, task_id, message_json, state, last_report_json, created_at,
  updated_at`;

function fromRow(row: DispatchRow): CobotDispatchRecord {
  return {
    requestId: row.request_id,
    gatewayId: row.gateway_id,
    deviceId: row.device_id,
    sourceKey: row.source_key,
    runActorId: row.run_actor_id,
    runId: row.run_id,
    taskId: row.task_id,
    message: JSON.parse(row.message_json) as CobotTaskMessage,
    state: row.state,
    lastReport:
      row.last_report_json === null
        ? null
        : (JSON.parse(row.last_report_json) as CobotReport),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readCobotDispatch(
  sql: SqlStorage,
  requestId: string,
): CobotDispatchRecord | null {
  const row = sql
    .exec<DispatchRow>(
      `SELECT ${COLUMNS} FROM cobot_dispatch WHERE request_id = ?`,
      requestId,
    )
    .toArray()[0];
  return row === undefined ? null : fromRow(row);
}

export function listRunDispatches(
  sql: SqlStorage,
  runActorId: string,
): readonly CobotDispatchRecord[] {
  return sql
    .exec<DispatchRow>(
      `SELECT ${COLUMNS} FROM cobot_dispatch WHERE run_actor_id = ?
        ORDER BY created_at, request_id`,
      runActorId,
    )
    .toArray()
    .map(fromRow);
}

/** Writes the dispatch before its send. False when the identity is known. */
export function insertCobotDispatch(
  sql: SqlStorage,
  input: Readonly<{
    gatewayId: string;
    deviceId: string;
    runActorId: string;
    message: CobotTaskMessage;
  }>,
  now: number,
): boolean {
  const cursor = sql.exec(
    `INSERT INTO cobot_dispatch (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', NULL, ?, ?)
     ON CONFLICT (request_id) DO NOTHING`,
    input.message.requestId,
    input.gatewayId,
    input.deviceId,
    input.message.sourceKey,
    input.runActorId,
    input.message.runId,
    input.message.taskId,
    JSON.stringify(input.message),
    now,
    now,
  );
  return cursor.rowsWritten > 0;
}

export function setCobotDispatchState(
  sql: SqlStorage,
  requestId: string,
  state: CobotDispatchState,
  now: number,
): void {
  sql.exec(
    `UPDATE cobot_dispatch SET state = ?, updated_at = ?
      WHERE request_id = ? AND state != ?`,
    state,
    now,
    requestId,
    state,
  );
}

/**
 * Records a report of a known dispatch. A dispatch whose result became
 * unknown keeps that state until a person settles it; the report is still
 * kept, so the run reads what the controller said. Returns the dispatch
 * before the change.
 */
export function recordCobotReport(
  sql: SqlStorage,
  gatewayId: string,
  report: CobotReport,
  now: number,
): CobotDispatchRecord | null {
  const before = readCobotDispatch(sql, report.requestId);
  if (before === null || before.gatewayId !== gatewayId) return null;
  if (
    before.lastReport !== null &&
    report.sequence !== 0 &&
    report.sequence <= before.lastReport.sequence
  )
    return before;
  const state: CobotDispatchState =
    before.state === "result_unknown" ? "result_unknown" : report.state;
  sql.exec(
    `UPDATE cobot_dispatch SET state = ?, last_report_json = ?, updated_at = ?
      WHERE request_id = ?`,
    state,
    JSON.stringify(report),
    now,
    report.requestId,
  );
  return before;
}

/** The open dispatches of a gateway whose socket ended now. */
export function markGatewayDispatchesUnknown(
  sql: SqlStorage,
  gatewayId: string,
  now: number,
): readonly CobotDispatchRecord[] {
  const open = sql
    .exec<DispatchRow>(
      `SELECT ${COLUMNS} FROM cobot_dispatch
        WHERE gateway_id = ? AND state IN ${OPEN_STATES}`,
      gatewayId,
    )
    .toArray()
    .map(fromRow);
  for (const dispatch of open)
    setCobotDispatchState(sql, dispatch.requestId, "result_unknown", now);
  return open;
}

export function unknownGatewayDispatches(
  sql: SqlStorage,
  gatewayId: string,
): readonly CobotDispatchRecord[] {
  return sql
    .exec<DispatchRow>(
      `SELECT ${COLUMNS} FROM cobot_dispatch
        WHERE gateway_id = ? AND state = 'result_unknown'`,
      gatewayId,
    )
    .toArray()
    .map(fromRow);
}

export function watchCobotRun(
  sql: SqlStorage,
  runActorId: string,
  devices: readonly Readonly<{ gatewayId: string; sourceKey: string }>[],
): void {
  sql.exec(
    "INSERT INTO cobot_run_known (run_actor_id) VALUES (?) ON CONFLICT DO NOTHING",
    runActorId,
  );
  for (const device of devices)
    sql.exec(
      `INSERT INTO cobot_run_watch (run_actor_id, gateway_id, source_key)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      runActorId,
      device.gatewayId,
      device.sourceKey,
    );
}

export function unwatchCobotRun(sql: SqlStorage, runActorId: string): void {
  sql.exec("DELETE FROM cobot_run_watch WHERE run_actor_id = ?", runActorId);
}

/** The runs that watch any of these devices of a gateway. */
export function watchingRuns(
  sql: SqlStorage,
  gatewayId: string,
  sourceKeys: readonly string[],
): readonly string[] {
  if (sourceKeys.length === 0) return [];
  const rows = sql
    .exec<{ run_actor_id: string; source_key: string }>(
      "SELECT run_actor_id, source_key FROM cobot_run_watch WHERE gateway_id = ?",
      gatewayId,
    )
    .toArray();
  const keys = new Set(sourceKeys);
  return [
    ...new Set(
      rows
        .filter((row) => keys.has(row.source_key))
        .map((row) => row.run_actor_id),
    ),
  ];
}

export function knownCobotRuns(sql: SqlStorage): readonly string[] {
  return sql
    .exec<{ run_actor_id: string }>("SELECT run_actor_id FROM cobot_run_known")
    .toArray()
    .map((row) => row.run_actor_id);
}

export function deleteGatewayCobotRecords(
  sql: SqlStorage,
  gatewayId: string,
): void {
  sql.exec("DELETE FROM cobot_run_watch WHERE gateway_id = ?", gatewayId);
}

export function pruneCobotDispatches(sql: SqlStorage, now: number): void {
  sql.exec(
    `DELETE FROM cobot_dispatch
      WHERE state NOT IN ${OPEN_STATES} AND state != 'result_unknown'
        AND updated_at < ?`,
    now - DISPATCH_RETENTION_MS,
  );
}
