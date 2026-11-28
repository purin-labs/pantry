import { isRecord } from "@purin-labs/std";
import type { CommandRejection, ControlCommand } from "./commands.ts";
import * as d from "./document-values.ts";
import type { AcceptedEvent } from "./events.ts";
import type {
  CellId,
  ExecutionId,
  Sha256Hex,
  SnapshotId,
  TaskId,
} from "./identity.ts";
import { err, ok, type Result } from "./result.ts";
import type { CompiledScenario, TaskDefinition } from "./scenario.ts";
import type { RunState, RunStatus } from "./state.ts";
import { TICK_MICROSECONDS, type LogicalTime } from "./time.ts";

/**
 * A saved run continued on another engine build (Refactor 16, step 8).
 *
 * A saved run is its inputs: the scenario, the cells of that scenario and
 * the commands that the engine admitted. A host of the same build restores
 * the saved checkpoints. A host of another build starts the scenario again,
 * applies each command where the saved run applied it, and stops where the
 * saved run stopped. The run then goes on. Its results can differ from the
 * saved recording, and {@link replayDifference} says where.
 */

/** What a controller's `define` command takes, read back from a definition. */
export type CellConfiguration = Readonly<Record<string, unknown>> &
  Readonly<{ fixture: string; cell: string }>;

const ROBOT_FIXTURES: Readonly<Record<string, string>> = {
  "persistent-rack/1": "rack",
  "persistent-oven-rack/1": "oven-rack",
  "persistent-spanner-oven-rack/1": "spanner-oven-rack",
  "persistent-pan-staging/1": "pan-staging",
};

/**
 * The configuration that made a saved cell definition. The saved definition
 * names its own build and its own model; a present controller defines the
 * same cell again from this configuration.
 */
export function cellConfiguration(
  raw: unknown,
): Result<CellConfiguration, string> {
  if (!isRecord(raw) || typeof raw.cellId !== "string")
    return err("A saved cell has no identity.");
  const cell = raw.cellId;
  if (raw.fixture === "persistent-espresso/1")
    return ok({
      fixture: "espresso",
      cell,
      // A definition from before the second machine names no appliance.
      appliance: raw.appliance === undefined ? "linea" : raw.appliance,
      ...(raw.grinder === undefined ? {} : { grinder: raw.grinder }),
    });
  if (raw.fixture === "persistent-pour-over/1") {
    const station = raw.station;
    if (!isRecord(station)) return err("A pour-over cell has no station.");
    return ok({
      fixture: "pour-over",
      cell,
      kettleWaterG: station.kettleWaterG,
      drainage: station.drainage,
      fault: station.fault,
      ...(station.grinder === undefined ? {} : { grinder: station.grinder }),
    });
  }
  const fixture =
    typeof raw.fixture === "string" ? ROBOT_FIXTURES[raw.fixture] : undefined;
  if (fixture === undefined || typeof raw.robot !== "string")
    return err("A saved cell has an unknown fixture.");
  return ok({ fixture, cell, robot: raw.robot });
}

/**
 * The saved definition, bound to the build of `present`. A definition holds
 * the inputs of a cell (its run name, its fixture, its robot, its station, a
 * load, a clamp force) and the pins of the build that made it: `execution`
 * and each hash of a model. The inputs stay as the save has them, so that
 * the same inputs give the same checkpoints. The pins, and a field that
 * only the present build has, come from the present definition.
 */
export function reboundDefinition(saved: unknown, present: unknown): unknown {
  if (!isRecord(saved) || !isRecord(present)) return null;
  const rebound: Record<string, unknown> = { ...present, ...saved };
  for (const [key, value] of Object.entries(present))
    if (key === "execution" || key.endsWith("Hash")) rebound[key] = value;
  return rebound;
}

/** Whether a present definition is the saved cell: its fixture and robot. */
export function sameCell(saved: unknown, present: unknown): boolean {
  return (
    isRecord(saved) &&
    isRecord(present) &&
    saved.fixture === present.fixture &&
    saved.cellId === present.cellId &&
    saved.robot === present.robot
  );
}

/** The model and the controller source that a present cell pins. */
export type CellBinding = Readonly<{
  modelHash: Sha256Hex;
  controllerSourceHash: Sha256Hex;
}>;

function reboundTask(
  task: TaskDefinition,
  saved: ReadonlyMap<CellId, Sha256Hex>,
  present: ReadonlyMap<CellId, CellBinding>,
): TaskDefinition {
  if (task.executor.kind !== "native") return task;
  const operation = task.executor.operation;
  const binding = present.get(operation.cell);
  // An operation of a cell pins that cell's model as its parameters.
  if (
    binding === undefined ||
    operation.parameters !== saved.get(operation.cell)
  )
    return task;
  return {
    ...task,
    executor: {
      kind: "native",
      operation: { ...operation, parameters: binding.modelHash },
    },
  };
}

/**
 * The saved scenario with each cell bound to the present build. Nothing else
 * changes: the tasks, the times and the resources are the saved inputs.
 */
export function rebindScenario(
  scenario: CompiledScenario,
  present: ReadonlyMap<CellId, CellBinding>,
): CompiledScenario {
  const saved = new Map<CellId, Sha256Hex>();
  const cells = [];
  for (const cell of scenario.cells) {
    saved.set(cell.id, cell.modelHash);
    const binding = present.get(cell.id);
    cells.push(binding === undefined ? cell : { ...cell, ...binding });
  }
  const workflows = [];
  for (const workflow of scenario.workflows) {
    const tasks = [];
    for (const task of workflow.tasks)
      tasks.push(reboundTask(task, saved, present));
    workflows.push({ ...workflow, tasks });
  }
  return { ...scenario, cells, workflows };
}

/** A task transition that a person reads on the timeline. */
type Transition = "task-started" | "task-completed" | "task-failed";

/**
 * Where the replayed run first leaves the saved recording. A protocol
 * projection: plain text and microseconds, as a caller of any build reads.
 */
type ReplayDifference = Readonly<{
  task: string;
  transition: Transition;
  /** Null when that run has no such transition. */
  saved: number | null;
  replayed: number | null;
}>;

function transitions(
  events: readonly AcceptedEvent[],
): Map<
  string,
  Readonly<{ task: TaskId; kind: Transition; time: LogicalTime }>
> {
  const found = new Map<
    string,
    Readonly<{ task: TaskId; kind: Transition; time: LogicalTime }>
  >();
  for (const event of events)
    if (
      event.kind === "task-started" ||
      event.kind === "task-completed" ||
      event.kind === "task-failed"
    ) {
      const key = `${event.kind} ${event.task}`;
      // A task that a recovery starts again keeps its first transition.
      if (!found.has(key))
        found.set(key, {
          task: event.task,
          kind: event.kind,
          time: event.time,
        });
    }
  return found;
}

/**
 * The earliest task transition that the two runs do not share, or null when
 * each task started, completed and failed at the same times in both.
 */
function replayDifference(
  saved: readonly AcceptedEvent[],
  replayed: readonly AcceptedEvent[],
): ReplayDifference | null {
  const before = transitions(saved);
  const after = transitions(replayed);
  let first: ReplayDifference | null = null;
  let firstAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of before) {
    const other = after.get(key);
    if (other?.time === entry.time) continue;
    const at = Math.min(entry.time, other?.time ?? entry.time);
    if (at < firstAt) {
      firstAt = at;
      first = {
        task: entry.task,
        transition: entry.kind,
        saved: entry.time,
        replayed: other?.time ?? null,
      };
    }
  }
  for (const [key, entry] of after) {
    if (before.has(key) || entry.time >= firstAt) continue;
    firstAt = entry.time;
    first = {
      task: entry.task,
      transition: entry.kind,
      saved: null,
      replayed: entry.time,
    };
  }
  return first;
}

/**
 * One admitted command of the saved run. `at` is the run time at which the
 * saved run took it. A decision on a task (an inspection or a recovery)
 * answers a condition of the run, so it waits for that condition.
 */
type ReplayStep = Readonly<{
  command: ControlCommand;
  at: LogicalTime;
  wait: "time" | "condition";
  /** The saved run took the command before it processed time zero. */
  beforeStart: boolean;
  /**
   * A pause that a later execution continued from. A host that restores a
   * paused save goes on with no resume command, so the replay releases this
   * pause in the same way.
   */
  continued: boolean;
}>;

export type ReplayPlan = Readonly<{
  parent: Readonly<{ snapshot: SnapshotId; execution: ExecutionId }>;
  /** The digest of the saved scenario, which an inspection names. */
  definition: Sha256Hex;
  steps: readonly ReplayStep[];
  end: Readonly<{ time: LogicalTime; status: RunStatus["kind"] }>;
  events: readonly AcceptedEvent[];
}>;

/** The inputs of a saved run, in the order in which the engine admitted them. */
export function replayPlan(saved: RunState, snapshot: SnapshotId): ReplayPlan {
  const steps: ReplayStep[] = [];
  const accepted = [];
  for (const entry of saved.commands)
    if (entry.receipt.status === "accepted") accepted.push(entry);
  for (const [index, { command, receipt }] of accepted.entries()) {
    if (receipt.status !== "accepted") continue;
    // The execution that took the next command, or that made the save.
    const later =
      accepted[index + 1]?.command.executionId ?? saved.identity.executionId;
    const immediate =
      command.kind === "pause" ||
      command.kind === "resume" ||
      command.kind === "recover" ||
      command.kind === "inspect";
    // Every other command takes effect one tick after the time of its
    // admission, so its admission was one tick earlier.
    const at =
      immediate || receipt.effectiveAt < TICK_MICROSECONDS
        ? receipt.effectiveAt
        : ((receipt.effectiveAt - TICK_MICROSECONDS) as LogicalTime);
    steps.push({
      command,
      at,
      wait:
        command.kind === "inspect" || command.kind === "recover"
          ? "condition"
          : "time",
      beforeStart: !immediate && receipt.effectiveAt === 0,
      continued: command.kind === "pause" && later !== command.executionId,
    });
  }
  return {
    parent: { snapshot, execution: saved.identity.executionId },
    definition: saved.definition.digest,
    steps,
    end: { time: saved.position.time, status: saved.status.kind },
    events: saved.events,
  };
}

type ReplayRefusal = Readonly<{
  commandId: string;
  kind: ControlCommand["kind"];
  reason: CommandRejection;
}>;

/**
 * Where a replay stands. `approach` drives to the time of the step,
 * `submit` gives the command to the engine, `retry` moves the run one
 * need of physics on before the same command goes again, and `release`
 * ends a pause that a later execution of the saved run continued from.
 */
export type ReplayCursor = Readonly<{
  index: number;
  phase: "approach" | "submit" | "retry" | "release";
  /** Refused submissions of the present step, and the last reason. */
  attempts: number;
  rejection: CommandRejection | null;
  refused: readonly ReplayRefusal[];
}>;

export const REPLAY_START: ReplayCursor = {
  index: 0,
  phase: "approach",
  attempts: 0,
  rejection: null,
  refused: [],
};

/** A pause settles within this many needs of physics, as in the Portal. */
const PAUSE_ATTEMPTS = 64;

export type ReplayAction =
  | Readonly<{ kind: "drive"; until: LogicalTime; turns: "budget" | "one" }>
  | Readonly<{ kind: "submit"; command: ControlCommand }>
  | Readonly<{ kind: "release" }>
  | Readonly<{ kind: "done" }>;

/**
 * The run after a continuation from a pause: it advances again, with no
 * command and no event, as a restored save does (`continueRun`).
 */
export function releasePause(run: RunState): RunState {
  return run.status.kind === "paused"
    ? { ...run, status: { kind: "advancing" } }
    : run;
}

/** The cursor after the host released the pause of the present step. */
export function afterReplayRelease(cursor: ReplayCursor): ReplayCursor {
  return {
    index: cursor.index + 1,
    phase: "approach",
    attempts: 0,
    rejection: null,
    refused: cursor.refused,
  };
}

function canAdvance(run: RunState): boolean {
  const status = run.status.kind;
  return (
    status === "ready" ||
    status === "advancing" ||
    status === "awaiting-execution"
  );
}

/** The saved command, addressed to the replayed execution. */
function addressed(
  plan: ReplayPlan,
  command: ControlCommand,
  run: RunState,
): ControlCommand {
  const target = {
    runId: run.identity.runId,
    executionId: run.identity.executionId,
    hostSession: run.identity.hostSession,
    expectedControlRevision: run.position.controlRevision,
  };
  // An inspection names the scenario that it decided on. The replayed
  // scenario is that scenario with its cells bound to the present build.
  if (command.kind === "inspect" && command.definition === plan.definition)
    return { ...command, ...target, definition: run.definition.digest };
  return { ...command, ...target };
}

/** The time that a waiting step may not pass: the next step with a time. */
function waitLimit(plan: ReplayPlan, index: number, run: RunState): number {
  for (let next = index + 1; next < plan.steps.length; next += 1) {
    const step = plan.steps[next];
    if (step !== undefined && step.wait === "time") return step.at;
  }
  return run.position.horizon;
}

function furthestBoundary(run: RunState): LogicalTime {
  let until = run.position.time + TICK_MICROSECONDS;
  for (const cell of run.cells)
    if (cell.committed.boundary > until) until = cell.committed.boundary;
  if (until > run.position.horizon) until = run.position.horizon;
  return until as LogicalTime;
}

/** What the host does next. It changes nothing; the host reports back. */
export function nextReplayAction(
  plan: ReplayPlan,
  cursor: ReplayCursor,
  run: RunState,
): ReplayAction {
  const step = plan.steps[cursor.index];
  if (step === undefined) {
    // Each command is applied. A saved run that stopped by itself (complete,
    // blocked, at an inspection or at a limit) is driven until it stops.
    if (plan.end.status === "paused" || !canAdvance(run))
      return { kind: "done" };
    return { kind: "drive", until: run.position.horizon, turns: "budget" };
  }
  if (cursor.phase === "release") return { kind: "release" };
  // Only a command that the saved run took before time zero goes to a run
  // that has not processed time zero.
  const unstarted = run.status.kind === "ready" && !step.beforeStart;
  if (
    cursor.phase === "approach" &&
    canAdvance(run) &&
    (unstarted || run.position.time < step.at)
  )
    return { kind: "drive", until: step.at, turns: "budget" };
  if (cursor.phase === "retry" && canAdvance(run))
    return {
      kind: "drive",
      until:
        step.wait === "condition"
          ? (Math.min(
              waitLimit(plan, cursor.index, run),
              run.position.horizon,
            ) as LogicalTime)
          : furthestBoundary(run),
      turns: "one",
    };
  return { kind: "submit", command: addressed(plan, step.command, run) };
}

function skipped(
  plan: ReplayPlan,
  cursor: ReplayCursor,
  rejection: CommandRejection,
): ReplayCursor {
  const step = plan.steps[cursor.index];
  if (step === undefined) return cursor;
  return {
    index: cursor.index + 1,
    phase: "approach",
    attempts: 0,
    rejection: null,
    refused: [
      ...cursor.refused,
      {
        commandId: step.command.commandId,
        kind: step.command.kind,
        reason: rejection,
      },
    ],
  };
}

/**
 * The cursor after the host drove the run for {@link nextReplayAction}.
 * `moved` says that the run changed. A run that a retry cannot move never
 * reaches the condition of its command, so the replay leaves that command.
 */
export function afterReplayDrive(
  plan: ReplayPlan,
  cursor: ReplayCursor,
  drive: Readonly<{ yielded: boolean; moved: boolean }>,
): ReplayCursor {
  // A drive that the host took back has not reached its time yet.
  if (cursor.phase === "approach" && drive.yielded) return cursor;
  if (cursor.phase === "retry" && !drive.moved && cursor.rejection !== null)
    return skipped(plan, cursor, cursor.rejection);
  return { ...cursor, phase: "submit" };
}

/** The cursor after the engine decided the command of the present step. */
export function afterReplaySubmit(
  plan: ReplayPlan,
  cursor: ReplayCursor,
  run: RunState,
  rejection: CommandRejection | null,
): ReplayCursor {
  const step = plan.steps[cursor.index];
  if (step === undefined) return cursor;
  if (rejection === null)
    return step.continued
      ? { ...cursor, phase: "release", attempts: 0, rejection: null }
      : afterReplayRelease(cursor);
  const attempts = cursor.attempts + 1;
  const waits =
    step.wait === "condition"
      ? (rejection === "inspection_unavailable" ||
          rejection === "recovery_unavailable" ||
          rejection === "recovery_resource_busy" ||
          rejection === "recovery_destination_full") &&
        run.position.time < waitLimit(plan, cursor.index, run)
      : rejection === "boundary_unsettled" && attempts < PAUSE_ATTEMPTS;
  if (waits && canAdvance(run))
    return { ...cursor, phase: "retry", attempts, rejection };
  return skipped(plan, cursor, rejection);
}

/**
 * What a caller reads about a replay while it runs and when it ends. A
 * protocol projection, like the host view.
 */
export type ReplayReport = Readonly<{
  /** The snapshot whose inputs this execution plays again. */
  snapshot: string;
  commands: number;
  applied: number;
  /** The time and the status at which the saved run stopped. */
  saved: Readonly<{ time: number; status: string }>;
}> &
  (
    | Readonly<{ state: "replaying"; refused?: never; difference?: never }>
    | Readonly<{
        state: "replayed";
        /** Saved commands that the present engine did not admit. */
        refused: readonly Readonly<{
          commandId: string;
          kind: string;
          reason: string;
        }>[];
        /** Null when each task has the times of the saved recording. */
        difference: ReplayDifference | null;
      }>
  );

function readRefusal(raw: unknown) {
  const r = d.record(raw, ["commandId", "kind", "reason"]);
  return {
    commandId: d.text(r.commandId),
    kind: d.text(r.kind),
    reason: d.text(r.reason),
  };
}

function readDifference(raw: unknown): ReplayDifference {
  const r = d.record(raw, ["task", "transition", "saved", "replayed"]);
  return {
    task: d.text(r.task),
    transition: d.choice(
      r.transition,
      "task-started",
      "task-completed",
      "task-failed",
    ),
    saved: d.nullable(r.saved, d.natural),
    replayed: d.nullable(r.replayed, d.natural),
  };
}

/**
 * Decodes the replay report of a host reply at the worker boundary. A reply
 * of an execution that plays no save again has none. An invalid report
 * throws `InvalidDocument`.
 */
export function readReplayReport(raw: unknown): ReplayReport | null {
  if (raw === undefined) return null;
  d.requireValue(isRecord(raw));
  const saved = d.record(raw.saved, ["time", "status"]);
  const head = {
    snapshot: d.text(raw.snapshot),
    commands: d.natural(raw.commands),
    applied: d.natural(raw.applied),
    saved: { time: d.natural(saved.time), status: d.text(saved.status) },
  };
  if (d.choice(raw.state, "replaying", "replayed") === "replaying")
    return { ...head, state: "replaying" };
  return {
    ...head,
    state: "replayed",
    refused: d.array(raw.refused, readRefusal),
    difference: d.nullable(raw.difference, readDifference),
  };
}

export function replayReport(
  plan: ReplayPlan,
  cursor: ReplayCursor,
  run: RunState,
  done: boolean,
): ReplayReport {
  const head = {
    snapshot: plan.parent.snapshot,
    commands: plan.steps.length,
    applied: cursor.index - cursor.refused.length,
    saved: plan.end,
  };
  if (!done) return { ...head, state: "replaying" };
  return {
    ...head,
    state: "replayed",
    refused: cursor.refused,
    difference: replayDifference(plan.events, run.events),
  };
}
