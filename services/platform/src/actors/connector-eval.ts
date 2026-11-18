import {
  evalTaskId,
  EVAL_SCORER_VERSION,
  parseEvalConfigurations,
  parseEvalRoutes,
  parseEvalTaskResult,
  settledEvalRunState,
  type EvalConfiguration,
  type EvalRevisionRef,
  type EvalRoute,
  type EvalRunProgress,
  type EvalRunResult,
  type EvalTaskKey,
  type EvalTaskResult,
} from "@seams/control-api";
import { isRecord, parseJsonOrNull } from "@seams/std";

/**
 * The eval runs of one mailbox agent while they are in progress.
 *
 * A run tries one accepted Eval revision. It is one Case, and each task of
 * it is one assignment on that Case, run in its own Session. The Connector
 * holds only the order of the work and what each task ended with. Tasks of
 * one run go one at a time, because a Case runs one transient assignment at
 * a time. A settled run is published to the OrganisationActor and its task
 * records are dropped here.
 */

/** How long a claimed task is held: one turn's wall time and a margin. */
export const EVAL_TASK_LEASE_MS = 6 * 60_000;
/** The most tokens one task's turn may use. */
export const EVAL_TASK_TOKEN_ALLOWANCE = 40_000;
/** The most tokens every task of one run may use together. */
export const EVAL_RUN_TOKEN_BUDGET = 400_000;
/** A task claimed this often without an end settles as indeterminate. */
export const EVAL_TASK_MAX_CLAIMS = 6;

const MAX_OPEN_EVAL_RUNS = 4;
const PUBLISHED_RUN_RETENTION_MS = 7 * 86_400_000;

export type ConnectorEvalRun = Readonly<{
  runId: string;
  commandId: string;
  eval: EvalRevisionRef;
  caseId: string;
  startedByPersonId: string;
  startedAt: number;
  routes: readonly EvalRoute[];
  configurations: readonly EvalConfiguration[];
  cancelledAt: number | null;
}>;

export type ConnectorEvalTask = EvalTaskKey & Readonly<{ position: number }>;

export type ClaimedEvalTask = Readonly<{
  run: ConnectorEvalRun;
  task: ConnectorEvalTask;
  /** How many times this task has been claimed, this claim included. */
  attempt: number;
}>;

/** What one task ended with, and the label of what its turn observed. */
export type SettledEvalTask = Readonly<{
  result: Omit<EvalTaskResult, keyof EvalTaskKey>;
  flowLabel: unknown;
}>;

export type EvalRunAdmission =
  | Readonly<{ kind: "admitted"; run: ConnectorEvalRun }>
  | Readonly<{ kind: "replayed"; run: ConnectorEvalRun }>
  | Readonly<{ kind: "command_conflict"; run?: never }>
  | Readonly<{ kind: "capacity_exceeded"; run?: never }>;

type RunRow = Readonly<{
  run_id: string;
  command_id: string;
  eval_id: string;
  eval_revision: number;
  case_id: string;
  started_by_person_id: string;
  started_at: number;
  routes_json: string;
  configurations_json: string;
  cancelled_at: number | null;
}>;

type TaskRow = Readonly<{
  run_id: string;
  position: number;
  task_id: string;
  scenario_id: string;
  configuration: string;
  route: string;
  state: string;
  attempts: number;
  result_json: string | null;
  flow_label_json: string | null;
}>;

const RUN_COLUMNS = `run_id, command_id, eval_id, eval_revision, case_id,
  started_by_person_id, started_at, routes_json, configurations_json, cancelled_at`;
const TASK_COLUMNS = `run_id, position, task_id, scenario_id, configuration, route,
  state, attempts, result_json, flow_label_json`;

export function createConnectorEvalSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_eval_run (
    run_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
    eval_id TEXT NOT NULL, eval_revision INTEGER NOT NULL CHECK (eval_revision > 0),
    case_id TEXT NOT NULL, started_by_person_id TEXT NOT NULL,
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    routes_json TEXT NOT NULL CHECK (json_valid(routes_json)),
    configurations_json TEXT NOT NULL CHECK (json_valid(configurations_json)),
    cancelled_at INTEGER, settled_at INTEGER, published_at INTEGER,
    publish_after INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_eval_task (
    run_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), task_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    configuration TEXT NOT NULL CHECK (configuration IN ('current', 'candidate')),
    route TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'settled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    flow_label_json TEXT CHECK (flow_label_json IS NULL OR json_valid(flow_label_json)),
    CHECK ((state = 'settled') = (result_json IS NOT NULL)),
    PRIMARY KEY (run_id, task_id)
  )`);
}

/**
 * The run that an earlier send of this command made. Null when this mailbox
 * holds no run for the command. An identity that carried another request is
 * a conflict.
 */
export function findEvalRunCommand(
  sql: SqlStorage,
  input: Readonly<{ commandId: string; requestDigest: string }>,
): Extract<EvalRunAdmission, { kind: "replayed" | "command_conflict" }> | null {
  const earlier = sql
    .exec<{ run_id: string; request_digest: string }>(
      "SELECT run_id, request_digest FROM connector_eval_run WHERE command_id = ?",
      input.commandId,
    )
    .toArray()[0];
  if (earlier === undefined) return null;
  const run = readEvalRun(sql, earlier.run_id);
  return earlier.request_digest === input.requestDigest && run !== null
    ? { kind: "replayed", run }
    : { kind: "command_conflict" };
}

/**
 * Admits one run and lays out its tasks: each scenario on each route under
 * each configuration. The same command sent again answers with the run it
 * made, and its identity carries no other request.
 */
export function admitEvalRun(
  sql: SqlStorage,
  input: Readonly<{
    runId: string;
    caseId: string;
    commandId: string;
    requestDigest: string;
    eval: EvalRevisionRef;
    scenarioIds: readonly string[];
    routes: readonly EvalRoute[];
    configurations: readonly EvalConfiguration[];
    startedByPersonId: string;
    now: number;
  }>,
): EvalRunAdmission {
  const earlier = findEvalRunCommand(sql, input);
  if (earlier !== null) return earlier;
  sql.exec(
    "DELETE FROM connector_eval_run WHERE published_at IS NOT NULL AND published_at < ?",
    input.now - PUBLISHED_RUN_RETENTION_MS,
  );
  const open = sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM connector_eval_run WHERE published_at IS NULL",
    )
    .toArray()[0]?.count;
  if (open === undefined || open >= MAX_OPEN_EVAL_RUNS)
    return { kind: "capacity_exceeded" };
  sql.exec(
    `INSERT INTO connector_eval_run (
       run_id, command_id, request_digest, eval_id, eval_revision, case_id,
       started_by_person_id, started_at, routes_json, configurations_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.runId,
    input.commandId,
    input.requestDigest,
    input.eval.evalId,
    input.eval.revision,
    input.caseId,
    input.startedByPersonId,
    input.now,
    JSON.stringify(input.routes),
    JSON.stringify(input.configurations),
  );
  let position = 0;
  for (const scenarioId of input.scenarioIds) {
    for (const route of input.routes) {
      for (const configuration of input.configurations) {
        sql.exec(
          `INSERT INTO connector_eval_task (
             run_id, position, task_id, scenario_id, configuration, route, state, available_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          input.runId,
          position,
          evalTaskId(scenarioId, configuration.kind, route),
          scenarioId,
          configuration.kind,
          route,
          input.now,
        );
        position += 1;
      }
    }
  }
  const run = readEvalRun(sql, input.runId);
  if (run === null) throw new Error("connector_eval_run_missing");
  return { kind: "admitted", run };
}

export function readEvalRun(
  sql: SqlStorage,
  runId: string,
): ConnectorEvalRun | null {
  const row = sql
    .exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM connector_eval_run WHERE run_id = ?`,
      runId,
    )
    .toArray()[0];
  return row === undefined ? null : restoreRun(row);
}

/**
 * When eval work is next due: the first unsettled task of a run in progress,
 * or at once for a run whose tasks have all settled and that is not yet
 * published.
 */
export function nextEvalWorkAt(sql: SqlStorage): number | null {
  const unpublished =
    sql
      .exec<{ publish_after: number | null }>(
        `SELECT MIN(publish_after) AS publish_after FROM connector_eval_run AS run
         WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM connector_eval_task
           WHERE run_id = run.run_id AND state != 'settled')`,
      )
      .toArray()[0]?.publish_after ?? null;
  const task =
    sql
      .exec<{ available_at: number | null }>(
        `SELECT MIN(task.available_at) AS available_at
         FROM connector_eval_task AS task
         JOIN connector_eval_run AS run ON run.run_id = task.run_id
         WHERE run.published_at IS NULL AND task.state != 'settled'
           AND task.position = (SELECT MIN(position) FROM connector_eval_task
             WHERE run_id = task.run_id AND state != 'settled')`,
      )
      .toArray()[0]?.available_at ?? null;
  if (unpublished === null) return task;
  return task === null ? unpublished : Math.min(unpublished, task);
}

/**
 * Claims the next due task: the first unsettled task of the oldest run that
 * has one due. The claim counts itself and holds the task for one lease. An
 * instance that stops with the turn leaves the task in place, and it is due
 * again when the lease ends.
 */
export function claimDueEvalTask(
  sql: SqlStorage,
  now: number,
): ClaimedEvalTask | null {
  const row = sql
    .exec<TaskRow>(
      `SELECT ${TASK_COLUMNS.split(",")
        .map((column) => `task.${column.trim()}`)
        .join(", ")}
       FROM connector_eval_task AS task
       JOIN connector_eval_run AS run ON run.run_id = task.run_id
       WHERE run.published_at IS NULL AND task.state != 'settled'
         AND task.available_at <= ?
         AND task.position = (SELECT MIN(position) FROM connector_eval_task
           WHERE run_id = task.run_id AND state != 'settled')
       ORDER BY run.started_at, run.run_id LIMIT 1`,
      now,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const run = readEvalRun(sql, row.run_id);
  const task = restoreTaskKey(row);
  if (run === null || task === null)
    throw new Error("connector_eval_task_invalid");
  sql.exec(
    `UPDATE connector_eval_task SET state = 'running', attempts = attempts + 1, available_at = ?
     WHERE run_id = ? AND task_id = ?`,
    now + EVAL_TASK_LEASE_MS,
    row.run_id,
    row.task_id,
  );
  return { run, task, attempt: row.attempts + 1 };
}

/** Makes a claimed task due again at `availableAt`. It stays claimed. */
export function deferEvalTask(
  sql: SqlStorage,
  input: Readonly<{ runId: string; taskId: string; availableAt: number }>,
): void {
  sql.exec(
    `UPDATE connector_eval_task SET available_at = ?
     WHERE run_id = ? AND task_id = ? AND state = 'running'`,
    input.availableAt,
    input.runId,
    input.taskId,
  );
}

/** Records what one task ended with. A settled task keeps its first end. */
export function settleEvalTask(
  sql: SqlStorage,
  input: Readonly<{ runId: string; taskId: string }> & SettledEvalTask,
): void {
  sql.exec(
    `UPDATE connector_eval_task SET state = 'settled', result_json = ?, flow_label_json = ?
     WHERE run_id = ? AND task_id = ? AND state != 'settled'`,
    JSON.stringify(input.result),
    input.flowLabel === null ? null : JSON.stringify(input.flowLabel),
    input.runId,
    input.taskId,
  );
}

/** The tokens the settled tasks of one run have used. */
export function evalRunTokensUsed(sql: SqlStorage, runId: string): number {
  return (
    sql
      .exec<{ tokens: number | null }>(
        `SELECT SUM(COALESCE(CAST(json_extract(result_json, '$.totalTokens') AS INTEGER), 0)) AS tokens
         FROM connector_eval_task WHERE run_id = ? AND state = 'settled'`,
        runId,
      )
      .toArray()[0]?.tokens ?? 0
  );
}

/**
 * Cancels a run in progress. Every task not yet claimed ends as cancelled. A
 * task whose turn is under way runs to its own end.
 */
export function cancelEvalRun(
  sql: SqlStorage,
  input: Readonly<{ evalId: string; runId: string; now: number }>,
): ConnectorEvalRun | null {
  // The run is found by its Eval as well as its identity, so a person who
  // may cancel one Eval's runs changes no run of another Eval.
  const run = sql
    .exec<{ published_at: number | null; pending: number }>(
      `SELECT published_at,
         (SELECT COUNT(*) FROM connector_eval_task task
          WHERE task.run_id = run.run_id AND task.state = 'pending') AS pending
       FROM connector_eval_run run WHERE run_id = ? AND eval_id = ?`,
      input.runId,
      input.evalId,
    )
    .toArray()[0];
  if (run === undefined) return null;
  // A run with no task left to start has nothing to cancel. It ends with
  // the results it has.
  if (run.published_at === null && run.pending > 0) {
    sql.exec(
      "UPDATE connector_eval_run SET cancelled_at = COALESCE(cancelled_at, ?) WHERE run_id = ?",
      input.now,
      input.runId,
    );
    const cancelled: SettledEvalTask["result"] = {
      outcome: { kind: "cancelled" },
      execution: null,
      pins: null,
      totalTokens: null,
    };
    sql.exec(
      `UPDATE connector_eval_task SET state = 'settled', result_json = ?
       WHERE run_id = ? AND state = 'pending'`,
      JSON.stringify(cancelled),
      input.runId,
    );
  }
  return readEvalRun(sql, input.runId);
}

/** The runs of one Eval still in progress here, oldest first. */
export function readEvalRunProgress(
  sql: SqlStorage,
  evalId: string,
): readonly EvalRunProgress[] {
  const rows = sql
    .exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM connector_eval_run
       WHERE eval_id = ? AND published_at IS NULL ORDER BY started_at, run_id`,
      evalId,
    )
    .toArray();
  return rows.map((row) => {
    const run = restoreRun(row);
    const tasks = readTaskRows(sql, run.runId);
    return {
      ...runHeader(run),
      state: tasks.some((task) => task.state !== "pending")
        ? "running"
        : "pending",
      tasks: tasks.map((task) => ({
        ...requireTaskKey(task),
        state: taskState(task.state),
      })),
    };
  });
}

/**
 * A run whose tasks have all settled and that is due for publication, with
 * the label of each task's turn. Null when there is none. The run takes its
 * settlement time the first time it is read here, so every later attempt to
 * publish it carries the same result.
 */
export function readSettledEvalRun(
  sql: SqlStorage,
  now: number,
): Readonly<{ result: EvalRunResult; flowLabels: readonly unknown[] }> | null {
  const row = sql
    .exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM connector_eval_run AS run
       WHERE published_at IS NULL AND publish_after <= ?
         AND NOT EXISTS (SELECT 1 FROM connector_eval_task
           WHERE run_id = run.run_id AND state != 'settled')
       ORDER BY started_at, run_id LIMIT 1`,
      now,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const run = restoreRun(row);
  sql.exec(
    "UPDATE connector_eval_run SET settled_at = COALESCE(settled_at, ?) WHERE run_id = ?",
    now,
    run.runId,
  );
  const settledAt = sql
    .exec<{ settled_at: number }>(
      "SELECT settled_at FROM connector_eval_run WHERE run_id = ?",
      run.runId,
    )
    .toArray()[0]?.settled_at;
  if (settledAt === undefined) throw new Error("connector_eval_run_missing");
  const tasks: EvalTaskResult[] = [];
  const flowLabels: unknown[] = [];
  for (const task of readTaskRows(sql, run.runId)) {
    const stored =
      task.result_json === null ? null : parseJsonOrNull(task.result_json);
    const result = isRecord(stored)
      ? parseEvalTaskResult({ ...requireTaskKey(task), ...stored })
      : null;
    if (result === null) throw new Error("connector_eval_task_result_invalid");
    tasks.push(result);
    if (task.flow_label_json !== null)
      flowLabels.push(parseJsonOrNull(task.flow_label_json));
  }
  return {
    result: {
      ...runHeader(run),
      state: settledEvalRunState(
        tasks.map((task) => task.outcome.kind),
        run.cancelledAt !== null,
      ),
      settledAt,
      tasks,
    },
    flowLabels,
  };
}

/** Puts off the next attempt to publish a settled run. */
export function deferEvalRunPublication(
  sql: SqlStorage,
  input: Readonly<{ runId: string; publishAfter: number }>,
): void {
  sql.exec(
    "UPDATE connector_eval_run SET publish_after = ? WHERE run_id = ? AND published_at IS NULL",
    input.publishAfter,
    input.runId,
  );
}

/** Marks a run published and drops its task records. */
export function markEvalRunPublished(
  sql: SqlStorage,
  input: Readonly<{ runId: string; now: number }>,
): void {
  sql.exec(
    "UPDATE connector_eval_run SET published_at = ? WHERE run_id = ? AND published_at IS NULL",
    input.now,
    input.runId,
  );
  sql.exec("DELETE FROM connector_eval_task WHERE run_id = ?", input.runId);
}

function runHeader(run: ConnectorEvalRun) {
  return {
    runId: run.runId,
    eval: run.eval,
    caseId: run.caseId,
    startedByPersonId: run.startedByPersonId,
    startedAt: run.startedAt,
    routes: run.routes,
    configurations: run.configurations,
    scorer: EVAL_SCORER_VERSION,
  };
}

function readTaskRows(sql: SqlStorage, runId: string): readonly TaskRow[] {
  return sql
    .exec<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM connector_eval_task WHERE run_id = ? ORDER BY position`,
      runId,
    )
    .toArray();
}

function restoreRun(row: RunRow): ConnectorEvalRun {
  const routes = parseEvalRoutes(parseJsonOrNull(row.routes_json));
  const configurations = parseEvalConfigurations(
    parseJsonOrNull(row.configurations_json),
  );
  if (routes === null || configurations === null)
    throw new Error("connector_eval_run_invalid");
  return {
    runId: row.run_id,
    commandId: row.command_id,
    eval: { evalId: row.eval_id, revision: row.eval_revision },
    caseId: row.case_id,
    startedByPersonId: row.started_by_person_id,
    startedAt: row.started_at,
    routes,
    configurations,
    cancelledAt: row.cancelled_at,
  };
}

function restoreTaskKey(row: TaskRow): ConnectorEvalTask | null {
  const route = parseEvalRoutes([row.route])?.[0];
  if (
    route === undefined ||
    (row.configuration !== "current" && row.configuration !== "candidate")
  )
    return null;
  return {
    position: row.position,
    taskId: row.task_id,
    scenarioId: row.scenario_id,
    configuration: row.configuration,
    route,
  };
}

function requireTaskKey(row: TaskRow): EvalTaskKey {
  const task = restoreTaskKey(row);
  if (task === null) throw new Error("connector_eval_task_invalid");
  const { position: _position, ...key } = task;
  return key;
}

function taskState(state: string): "pending" | "running" | "settled" {
  if (state === "pending" || state === "running" || state === "settled")
    return state;
  throw new Error("connector_eval_task_invalid");
}
