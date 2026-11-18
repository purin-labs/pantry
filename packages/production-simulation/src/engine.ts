import { assertNever, sameJson } from "@seams/std";
import { inspectionDecision, ruleOutcome } from "./inspections.ts";
import { executionWork, outputCeiling } from "./scenario.ts";
import { taskWaits } from "./scheduling-history.ts";
import {
  admitBatchLoad,
  batchBlockers,
  batchCanStart,
  beginBatch,
  settleBatches,
} from "./engine-batches.ts";
import type { AdmittedScenario } from "./admission.ts";
import {
  BoundaryRequired,
  bindCarriers,
  boundCarrier,
  carrierBlockers,
  failCarriers,
  nativeMoves,
  pickUp,
  place,
  releaseCarriers,
  wake,
} from "./engine-carriers.ts";
import {
  arrivalOf,
  arrivalTime,
  emit,
  freeze,
  held,
  isWorkflowTask,
  taskDefinition,
  thaw,
  type Draft,
  type WorkflowTask,
} from "./engine-draft.ts";
import { compareOrder, type AcceptedEvent, type OrderKey } from "./events.ts";
import { removeRecoveredCarrier, settleRecovery } from "./engine-recovery.ts";
import {
  claimResource,
  holdTaskResources,
  releaseTaskResources,
} from "./engine-resources.ts";
import {
  assignWorker,
  availableWorker,
  finishWorker,
} from "./engine-workers.ts";
import {
  attemptId,
  changeoverTaskId,
  instanceLotId,
  taskId,
  workflowInstanceId,
  type AttemptId,
  type CarrierId,
  type CellId,
  type CommandId,
  type ConfigurationId,
  type LotId,
  type ProductId,
  type StorageId,
  type TaskId,
  type TaskKey,
} from "./identity.ts";
import type {
  CheckpointRef,
  Measurement,
  OperationDispatch,
  Terminal,
} from "./physics.ts";
import {
  addQuantity,
  subtractQuantity,
  zeroQuantity,
  type MaterialQuantity,
  type QuantityError,
} from "./quantity.ts";
import { err, ok, type Result } from "./result.ts";
import type {
  DecisionOutcome,
  Changeover,
  NativeOperation,
  ResourceClaim,
  ResourceDefinition,
  TaskDefinition,
} from "./scenario.ts";
import type {
  Blocker,
  CarrierState,
  CellState,
  ExecutionIdentity,
  LotState,
  ResourceState,
  RunState,
  ScheduledEvent,
  StorageState,
  TaskState,
  WorkflowInstanceState,
} from "./state.ts";
import {
  ZERO_DURATION,
  ZERO_STEPS,
  ZERO_TIME,
  TICK_MICROSECONDS,
  advance as later,
  elapsed,
  intervalContains,
  lookaheadHorizon,
  sharedLookaheadHorizon,
  stepsBetween,
  tickDuration,
  type LogicalTime,
} from "./time.ts";
import type { Variant } from "@seams/type-utils";

/**
 * The production engine: one owner of logical time, task lifecycle, resource
 * allocation, material accounting, carrier custody and accepted events. It
 * advances from the state it is given and never recompiles accepted history.
 *
 * Logical time passes only through intervals physics has evidenced. A run
 * with a cell stops with the one thing it needs from the physics host, and
 * continues when that evidence is accepted. Multiple cells meet at each
 * factory tick before any event at that tick can change their inputs.
 */

type UnsupportedFeature = "carrier_starts_in_cell";

export type EngineError =
  | Readonly<{
      code: "unsupported_scenario";
      features: readonly UnsupportedFeature[];
    }>
  | Readonly<{ code: "bundle_required" }>
  | Readonly<{ code: "cell_not_opened"; cell: CellId }>
  | Readonly<{ code: "unknown_cell"; cell: CellId }>;

/** A cell's world as its adapter created it, before the run starts. */
export type OpenedCell = Readonly<{ cell: CellId; checkpoint: CheckpointRef }>;

type OpenSource = Variant<RunState["arrivals"][number], "open">;

export function startRun(
  definition: AdmittedScenario,
  identity: ExecutionIdentity,
  opened: readonly OpenedCell[],
): Result<RunState, EngineError> {
  const { scenario } = definition;
  const features = new Set<UnsupportedFeature>();
  for (const carrier of scenario.carriers)
    for (const storage of scenario.storages)
      if (storage.id === carrier.storage && storage.cell !== null)
        features.add("carrier_starts_in_cell");
  if (features.size > 0)
    return err({
      code: "unsupported_scenario",
      features: [...features].sort(),
    });
  if (scenario.cells.length > 0 && identity.bundle === null)
    return err({ code: "bundle_required" });
  const checkpoints = new Map<CellId, CheckpointRef>();
  for (const cell of opened) checkpoints.set(cell.cell, cell.checkpoint);
  const cells: CellState[] = [];
  for (const cell of scenario.cells) {
    const checkpoint = checkpoints.get(cell.id);
    if (checkpoint === undefined)
      return err({ code: "cell_not_opened", cell: cell.id });
    checkpoints.delete(cell.id);
    cells.push({
      id: cell.id,
      slot: { kind: "inactive", generation: 0 },
      committed: {
        checkpoint,
        boundary: ZERO_TIME,
        clock: {
          origin: ZERO_TIME,
          steps: checkpoint.step,
          held: ZERO_DURATION,
        },
      },
      pending: null,
      // No hold is taken yet: an idle cell advances with the factory clock.
      hold: { kind: "evolving" },
      attempt: null,
      prepared: [],
    });
  }
  for (const cell of checkpoints.keys())
    return err({ code: "unknown_cell", cell });

  const scheduled: ScheduledEvent[] = [];
  for (const availability of scenario.availability)
    for (const edge of ["start", "end"] as const)
      scheduled.push({
        kind: "availability-edge",
        resource: availability.resource,
        cause: availability.id,
        order: {
          time: availability.interval[edge],
          phase: "control",
          origin: "availability",
          cause: availability.id,
          edge,
        },
      });
  const storages: StorageState[] = [];
  const events: AcceptedEvent[] = [];
  events.push({
    kind: "waiting-changed",
    waiting: [],
    sequence: 1,
    time: ZERO_TIME,
    execution: identity.executionId,
  });
  for (const storageDefinition of scenario.storages) {
    const storage = initialStorage(definition, storageDefinition);
    storages.push(storage);
    if (storageDefinition.capacity.kind !== "carriers") continue;
    events.push({
      kind: "storage-changed",
      sequence: events.length + 1,
      time: ZERO_TIME,
      execution: identity.executionId,
      storage: storage.id,
      occupants: storage.occupants,
      reservations: storage.reservations,
    });
  }
  return ok({
    identity,
    definition,
    position: {
      time: ZERO_TIME,
      eventSequence: events.length,
      controlRevision: 0,
      horizon: scenario.limits.horizon,
    },
    status: { kind: "ready" },
    arrivals: scenario.arrivals.map(openSource),
    instances: [],
    tasks: [],
    resources: scenario.resources.map(initialResource.bind(null, definition)),
    storages,
    carriers: scenario.carriers.map(initialCarrier),
    lots: scenario.stock.map(initialLot),
    cells,
    scheduled,
    commands: [],
    events,
  });
}

function openSource(
  source: AdmittedScenario["scenario"]["arrivals"][number],
): RunState["arrivals"][number] {
  return { id: source.id, next: 0, kind: "open" };
}

function initialResource(
  definition: AdmittedScenario,
  resource: ResourceDefinition,
): ResourceState {
  const withheld: ResourceState["withheld"][number][] = [];
  for (const availability of definition.scenario.availability)
    if (availability.resource === resource.id)
      withheld.push({
        cause: availability.id,
        interval: availability.interval,
      });
  return {
    id: resource.id,
    batch: resource.kind === "batch" ? { kind: "idle", sequence: 0 } : null,
    position:
      resource.kind === "worker"
        ? { kind: "idle", at: resource.initialLocation }
        : { kind: "fixed" },
    configuration: resource.configuration?.initial ?? null,
    changeovers: 0,
    allocations: [],
    withheld,
  };
}

function initialStorage(
  definition: AdmittedScenario,
  storage: AdmittedScenario["scenario"]["storages"][number],
): StorageState {
  const occupants: CarrierId[] = [];
  for (const carrier of definition.scenario.carriers)
    if (carrier.storage === storage.id) occupants.push(carrier.id);
  return { id: storage.id, occupants, reservations: [] };
}

function initialCarrier(
  carrier: AdmittedScenario["scenario"]["carriers"][number],
): CarrierState {
  return {
    id: carrier.id,
    custody: { kind: "stored", storage: carrier.storage },
    bound: null,
  };
}

function initialLot(
  lot: AdmittedScenario["scenario"]["stock"][number],
): LotState {
  return {
    id: lot.id,
    product: lot.product,
    remaining: lot.quantity,
    claims: [],
    lineage: [],
    origin: { kind: "initial-stock" },
    disposition: "released",
    holder: { kind: "storage", storage: lot.storage },
  };
}

/**
 * Processes every timestamp up to and including `until`, then returns. It
 * stops earlier when the run completes, blocks, reaches a limit or needs
 * evidence from physics. Calling it again continues from the returned state:
 * slicing never changes the result.
 */
export function advanceRun(run: RunState, until: LogicalTime): RunState {
  if (run.status.kind !== "ready" && run.status.kind !== "advancing")
    return run;
  // One draft serves every timestamp; `state` is the last whole timestamp.
  let state = run;
  const draft = thaw(state);
  for (;;) {
    const next = decide(draft, until);
    if (next === null) return freeze(draft);
    try {
      processTimestamp(draft, next);
    } catch (error) {
      if (!(error instanceof BoundaryRequired)) throw error;
      // The timestamp is abandoned whole: nothing of it was applied.
      const waiting = thaw(state);
      waiting.status = {
        kind: "awaiting-execution",
        need: { kind: "boundary", request: error.request, at: next },
      };
      return freeze(waiting);
    }
    state = freeze(draft);
  }
}

/**
 * The cell that must keep pace with the factory clock, if one must. A cell
 * in a settled hold keeps its state without stepping. A failed cell keeps
 * integrating under its stopped servo targets until recovery resolves it.
 * Of the cells at the earliest boundary, a cell with an operation goes
 * first: its advance lets a resting cell take a longer step after it.
 */
function evolvingCell(draft: Draft): CellState | null {
  let lagging: CellState | null = null;
  for (const cell of draft.cells.values()) {
    if (cell.hold.kind === "settled") continue;
    if (
      lagging === null ||
      cell.committed.boundary < lagging.committed.boundary ||
      (cell.committed.boundary === lagging.committed.boundary &&
        (eventSource(cell) === eventSource(lagging)
          ? cell.id < lagging.id
          : eventSource(cell)))
    )
      lagging = cell;
  }
  return lagging;
}

/**
 * Whether the cell can report an event that no record holds yet: a pickup,
 * a removal or the end of an operation. Only a cell with an operation that
 * is dispatched or running can. A resting cell reports only that its hold
 * qualifies, and a hold entry commands no cell.
 */
function eventSource(cell: CellState): boolean {
  const lifecycle = cell.attempt?.lifecycle.kind;
  return (
    cell.hold.kind !== "settled" &&
    (lifecycle === "dispatched" || lifecycle === "running")
  );
}

/** Whether the cell's next physics is a rest under its held servo targets. */
function rests(cell: CellState): boolean {
  return cell.attempt === null || cell.hold.kind === "unresolved";
}

/**
 * The latest time a resting cell may reach before the other cells report
 * what they did: one tick after the boundary of each other cell that runs
 * an operation, or null when no other cell can report an unknown event.
 * An unknown event lies at least one tick after its cell's boundary, and
 * every command it causes to a resting cell takes effect at its own time.
 */
function earliestUnknownEvent(
  draft: Draft,
  resting: CellState,
): LogicalTime | null {
  const tick = tickDuration(TICK_MICROSECONDS);
  if (!tick.ok) throw new Error("The factory tick is invalid");
  let earliest: LogicalTime | null = null;
  for (const cell of draft.cells.values()) {
    if (cell.id === resting.id || !eventSource(cell)) continue;
    const time = later(cell.committed.boundary, tick.value);
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest;
}

function hasAttempt(draft: Draft): boolean {
  for (const cell of draft.cells.values())
    if (cell.hold.kind === "evolving" && cell.attempt !== null) return true;
  return false;
}

function workflowTaskOf(draft: Draft, id: TaskId): WorkflowTask {
  const task = held(draft.tasks, id, "task");
  if (!isWorkflowTask(task)) throw new Error(`Task ${id} is no workflow task`);
  return task;
}

function definitionOf(draft: Draft, task: WorkflowTask): TaskDefinition {
  return taskDefinition(
    draft,
    held(draft.instances, task.subject.instance, "instance"),
    task.subject.key,
  );
}

/**
 * Whether a completion fits the attempt's task. A recovery measures nothing;
 * a workflow attempt measures exactly its task's measured outputs.
 */
export function completionFits(
  draft: Draft,
  task: TaskId,
  measurements: readonly Measurement[],
): boolean {
  const state = held(draft.tasks, task, "task");
  if (state.kind === "recovering" || !isWorkflowTask(state))
    return measurements.length === 0;
  return measurementsFit(definitionOf(draft, state), measurements);
}

function dispatchOf(
  draft: Draft,
  cell: CellState,
  attempt: NonNullable<CellState["attempt"]>,
): OperationDispatch {
  const task = workflowTaskOf(draft, attempt.task);
  const executor = definitionOf(draft, task).executor;
  if (executor.kind !== "native")
    throw new Error(`Task ${attempt.task} has no native operation`);
  return {
    runId: draft.identity.runId,
    executionId: draft.identity.executionId,
    cellId: cell.id,
    attemptId: attempt.id,
    task: attempt.task,
    definition: draft.definition.digest,
    dispatchedAt: attempt.dispatchedAt,
    startingCheckpoint: attempt.startingCheckpoint,
    slot: cell.slot,
    operation: executor.operation,
    origin: attempt.origin,
    purpose:
      task.kind === "recovering"
        ? {
            kind: "recovery",
            carrier: task.recovery.carrier,
            handling: elapsed(task.recovery.startedAt, task.recovery.removesAt),
          }
        : { kind: "workflow" },
  };
}

/**
 * The next timestamp to process, or null once the draft's status says why
 * the run stops here: it finished, reached a limit or `until`, or needs
 * physics before logical time may pass.
 */
function decide(draft: Draft, until: LogicalTime): LogicalTime | null {
  for (const task of draft.tasks.values()) {
    if (
      task.kind === "waiting" &&
      task.blockers.length === 1 &&
      task.blockers[0]?.kind === "inspection" &&
      inspectionDecision(draft.commands, task.id) === null
    ) {
      draft.status = { kind: "awaiting-inspection", task: task.id };
      return null;
    }
  }
  const cap = draft.definition.scenario.limits.eventCap;
  const cell = evolvingCell(draft);
  if (cell !== null && cell.attempt?.lifecycle.kind === "dispatched") {
    draft.status = {
      kind: "awaiting-execution",
      need: { kind: "start", dispatch: dispatchOf(draft, cell, cell.attempt) },
    };
    return null;
  }
  const next = nextTimestamp(draft);
  // The time through which the cell's state is evidenced.
  const coverage = cell === null ? null : cell.committed.boundary;
  if (next !== null && (coverage === null || next <= coverage)) {
    // Checked between timestamps, so one timestamp is never half applied.
    if (draft.events.length >= cap) {
      stopAtLimit(draft, "events");
      return null;
    }
    const boundary = until < draft.horizon ? until : draft.horizon;
    if (next > boundary) {
      // Every evolving cell covers this boundary, or all cells have qualified
      // holds. Commit the requested time even when the next task releases later.
      if (draft.time < boundary) return boundary;
      if (draft.time >= draft.horizon) stopAtLimit(draft, "horizon");
      else draft.status = { kind: "advancing" };
      return null;
    }
    return next;
  }
  if (
    cell === null ||
    coverage === null ||
    (next === null && !hasAttempt(draft))
  ) {
    finish(draft);
    return null;
  }
  // Every timestamp through the cell's boundary is processed.
  if (coverage > draft.time) draft.time = coverage;
  if (coverage >= draft.horizon) {
    stopAtLimit(draft, "horizon");
    return null;
  }
  if (draft.events.length >= cap) {
    stopAtLimit(draft, "events");
    return null;
  }
  if (coverage >= until) {
    draft.status = { kind: "advancing" };
    return null;
  }
  // Each cell has its own world, and cells meet only at events: a command
  // to a cell takes effect at its event's time, where the cell must have
  // real state. A cell with an operation receives no command until it
  // ends, so it computes to the grid. A resting cell computes no further
  // than the first event that another cell may still report, and it stops
  // where its hold qualifies, as it would one step at a time.
  const shared = draft.cells.size > 1;
  let target = shared
    ? sharedLookaheadHorizon(coverage, next)
    : lookaheadHorizon(coverage, next);
  if (shared && rests(cell)) {
    const barrier = earliestUnknownEvent(draft, cell);
    if (barrier !== null && target > barrier) target = barrier;
  }
  if (target > draft.horizon) target = draft.horizon;
  if (target > until) target = until;
  const steps = stepsBetween(coverage, target);
  draft.status = {
    kind: "awaiting-execution",
    need:
      cell.attempt === null || cell.hold.kind === "unresolved"
        ? {
            kind: "rest",
            cellId: cell.id,
            predecessor: cell.committed.checkpoint.digest,
            steps,
            stopAtHold: shared,
          }
        : {
            kind: "advance",
            attempt: {
              runId: draft.identity.runId,
              executionId: draft.identity.executionId,
              cellId: cell.id,
              attemptId: cell.attempt.id,
            },
            steps,
          },
  };
  return null;
}

function nextTimestamp(draft: Draft): LogicalTime | null {
  let next: LogicalTime | null =
    draft.status.kind === "ready" ? ZERO_TIME : null;
  // The end of a hold's qualification keeps no run going by itself.
  let pending = next !== null;
  for (const event of draft.scheduled) {
    if (event.kind !== "hold-expiry") pending = true;
    if (next === null || event.order.time < next) next = event.order.time;
  }
  for (const source of draft.arrivals.values()) {
    if (source.kind !== "open") continue;
    const time = arrivalTime(
      held(draft.index.sources, source.id, "arrival source"),
      source.next,
    );
    if (time === null) continue;
    pending = true;
    if (next === null || time < next) next = time;
  }
  for (const task of draft.tasks.values()) {
    if (task.kind !== "waiting" || !isWorkflowTask(task)) continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    const releaseAt = later(
      instance.arrival.time,
      definitionOf(draft, task).releaseAfter,
    );
    if (releaseAt <= draft.time) continue;
    pending = true;
    if (next === null || releaseAt < next) next = releaseAt;
  }
  for (const resource of draft.resources.values()) {
    if (
      resource.batch?.kind !== "loading" ||
      resource.batch.closeAt <= draft.time
    )
      continue;
    pending = true;
    if (next === null || resource.batch.closeAt < next)
      next = resource.batch.closeAt;
  }
  return pending ? next : null;
}

function unfinished(draft: Draft): TaskId[] {
  const tasks: TaskId[] = [];
  for (const task of draft.tasks.values())
    if (
      task.kind !== "completed" &&
      task.kind !== "skipped" &&
      task.kind !== "failed" &&
      task.kind !== "cancelled"
    )
      tasks.push(task.id);
  return tasks;
}

// No event remains that could release waiting work: it is blocked, not late.
function finish(draft: Draft): void {
  const [first, ...rest] = unfinished(draft);
  draft.status =
    first === undefined
      ? { kind: "completed", completedAt: draft.time }
      : { kind: "blocked", tasks: [first, ...rest] };
}

function stopAtLimit(draft: Draft, limit: "horizon" | "events"): void {
  emit(draft, draft.time, { kind: "limit-reached", limit });
  draft.status = {
    kind: "stopped-at-limit",
    limit,
    unfinished: unfinished(draft),
  };
}

/**
 * One timestamp: settle what is known to end now, apply control and arrivals,
 * then allocate and dispatch until nothing more can start.
 */
function processTimestamp(draft: Draft, time: LogicalTime): void {
  const previousWaiting = taskWaits(draft.tasks.values());
  draft.time = time;
  draft.status = { kind: "advancing" };
  for (
    let due = take(draft, time, "settle");
    due !== null;
    due = take(draft, time, "settle")
  )
    settle(draft, time, due);
  settleBatches(draft, time);
  control(draft, time);
  dispatch(draft, time);
  for (const task of draft.tasks.values())
    if (task.kind === "waiting" && isWorkflowTask(task))
      draft.tasks.set(task.id, {
        ...task,
        blockers: blockersOf(draft, task, time),
      });
  const waiting = taskWaits(draft.tasks.values());
  if (!sameJson(previousWaiting, waiting))
    emit(draft, time, { kind: "waiting-changed", waiting });
}

/** Removes and returns the first scheduled event of `phase` due at `time`. */
function take(
  draft: Draft,
  time: LogicalTime,
  phase: OrderKey["phase"],
): ScheduledEvent | null {
  let first = -1;
  for (const [index, event] of draft.scheduled.entries()) {
    if (event.order.time !== time || event.order.phase !== phase) continue;
    const current = draft.scheduled[first];
    if (current === undefined || compareOrder(event.order, current.order) < 0)
      first = index;
  }
  const event = draft.scheduled[first];
  if (event === undefined) return null;
  draft.scheduled = draft.scheduled.filter(isNot.bind(null, event));
  return event;
}

function isNot<Value>(excluded: Value, value: Value): boolean {
  return value !== excluded;
}

function settle(draft: Draft, time: LogicalTime, due: ScheduledEvent): void {
  if (
    due.kind === "availability-edge" ||
    due.kind === "command" ||
    due.kind === "hold-entry" ||
    due.kind === "hold-expiry"
  )
    throw new Error(`Unexpected ${due.kind} in the settle phase`);
  const task = held(draft.tasks, due.task, "task");
  if (task.kind === "recovering") {
    if (due.kind === "native-event" && due.event.kind === "carrier-removed")
      removeRecoveredCarrier(draft, time, task);
    else if (due.kind === "native-terminal")
      settleRecovery(draft, time, task, due.terminal);
    else throw new Error("Recovery received another task's event");
    return;
  }
  if (task.kind !== "executing")
    throw new Error(`Task ${task.id} settles without executing`);
  if (!isWorkflowTask(task)) {
    completeChangeover(draft, time, task, task.startedAt);
    return;
  }
  const definition = definitionOf(draft, task);
  switch (due.kind) {
    case "task-boundary": {
      const order = due.order;
      if (order.phase !== "settle" || order.origin !== "declared")
        throw new Error("A declared boundary lacks its order");
      if (order.boundary === "completion")
        completeTask(draft, time, task, task.startedAt, null, []);
      else if (due.carrierStep === null)
        throw new Error(`Task ${task.id} moves no carrier at its boundary`);
      else if (order.boundary === "pickup")
        pickUp(draft, time, task, definition, due.carrierStep);
      else place(draft, time, task, definition, due.carrierStep);
      return;
    }
    case "native-event":
      // A controller's pickup takes every carrier its operation moves.
      if (due.event.kind === "pickup")
        for (const carrierStep of nativeMoves(definition))
          pickUp(draft, time, task, definition, carrierStep);
      return;
    case "native-terminal":
      settleTerminal(draft, time, task, definition, due.terminal);
      return;
    default:
      assertNever(due, "Unexpected scheduled event");
  }
}

/**
 * The accepted end of a native attempt. Completion places its carriers and
 * frees the cell; failure holds the task's resources and the cell until an
 * explicit recovery, and never invents a placement.
 */
function settleTerminal(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
  terminal: Terminal,
): void {
  if (definition.executor.kind !== "native" || task.kind !== "executing")
    throw new Error(`Task ${task.id} has no native attempt to settle`);
  const cell = held(draft.cells, definition.executor.operation.cell, "cell");
  if (terminal.outcome === "completed") {
    for (const carrierStep of nativeMoves(definition))
      place(draft, time, task, definition, carrierStep);
    draft.cells.set(cell.id, { ...cell, attempt: null });
    emit(draft, time, {
      kind: "cell-committed",
      cell: cell.id,
      checkpoint: terminal.checkpoint.digest,
      boundary: null,
    });
    completeTask(
      draft,
      time,
      task,
      task.startedAt,
      terminal.attemptId,
      terminal.measurements,
    );
    return;
  }
  failCarriers(draft, time, task, definition, terminal.disposition);
  holdTaskResources(draft, time, task.id);
  draft.cells.set(cell.id, {
    ...cell,
    hold: { kind: "unresolved", since: time },
  });
  draft.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    kind: "recovery-required",
    startedAt: task.startedAt,
    failedAt: time,
    attempt: terminal.attemptId,
    disposition: terminal.disposition,
  });
  emit(draft, time, {
    kind: "task-failed",
    task: task.id,
    attempt: terminal.attemptId,
    disposition: terminal.disposition,
  });
}

// Commands first, then availability with ends before starts, then arrivals.
function control(draft: Draft, time: LogicalTime): void {
  for (;;) {
    const scheduled = take(draft, time, "control");
    if (scheduled !== null) {
      applyControl(draft, time, scheduled);
      continue;
    }
    const source = dueSource(draft, time);
    if (source === null) return;
    arrive(draft, time, source);
  }
}

function applyControl(
  draft: Draft,
  time: LogicalTime,
  scheduled: ScheduledEvent,
): void {
  switch (scheduled.kind) {
    case "availability-edge": {
      const order = scheduled.order;
      if (order.phase !== "control" || order.origin !== "availability")
        throw new Error("An availability edge lacks its order");
      emit(draft, time, {
        kind: "availability-changed",
        resource: scheduled.resource,
        available: order.edge === "end",
        cause: scheduled.cause,
      });
      return;
    }
    case "command":
      applyCommand(draft, time, scheduled.command);
      return;
    // The hold's qualification ends here: the cell advances again.
    case "hold-expiry":
      wake(draft, scheduled.cell, time);
      return;
    case "hold-entry": {
      const cell = held(draft.cells, scheduled.cell, "cell");
      if (cell.hold.kind !== "settled" || cell.hold.enteredAt !== time)
        throw new Error("A hold entry lacks its qualified state");
      emit(draft, time, {
        kind: "cell-hold",
        cell: cell.id,
        state: "entered",
        model: cell.hold.model,
      });
      return;
    }
    case "task-boundary":
    case "native-event":
    case "native-terminal":
      throw new Error(`Unexpected ${scheduled.kind} in the control phase`);
    default:
      assertNever(scheduled, "Unexpected scheduled event");
  }
}

function applyCommand(
  draft: Draft,
  time: LogicalTime,
  commandId: CommandId,
): void {
  let record = null;
  for (const candidate of draft.commands)
    if (candidate.command.commandId === commandId) record = candidate;
  if (record === null || record.receipt.status !== "accepted")
    throw new Error(`No admitted command ${commandId}`);
  const command = record.command;
  switch (command.kind) {
    case "withhold-resource": {
      const resource = held(draft.resources, command.resource, "resource");
      draft.resources.set(resource.id, {
        ...resource,
        withheld: [
          ...resource.withheld,
          { cause: command.commandId, interval: command.interval },
        ],
      });
      for (const edge of ["start", "end"] as const)
        draft.scheduled.push({
          kind: "availability-edge",
          resource: resource.id,
          cause: command.commandId,
          order: {
            time: command.interval[edge],
            phase: "control",
            origin: "availability",
            cause: command.commandId,
            edge,
          },
        });
      break;
    }
    case "close-arrivals": {
      const source = held(draft.arrivals, command.source, "arrival source");
      if (source.kind === "open") {
        draft.arrivals.set(source.id, {
          id: source.id,
          next: source.next,
          kind: "closed",
          closedAt: time,
          command: command.commandId,
        });
        emit(draft, time, { kind: "arrivals-closed", source: source.id });
      }
      break;
    }
    case "update-worker-travel":
      draft.workerTravel.set(command.resource, command.travel);
      break;
    case "inspect":
    case "extend-horizon":
    case "pause":
    case "resume":
    case "recover":
      break;
    default:
      assertNever(command, "Unexpected command");
  }
  emit(draft, time, {
    kind: "command-admitted",
    command: command.commandId,
    controlRevision: record.receipt.controlRevision,
  });
}

/** The open source whose next arrival is due now and first in arrival order. */
function dueSource(draft: Draft, time: LogicalTime): OpenSource | null {
  let first: OpenSource | null = null;
  for (const source of draft.arrivals.values()) {
    if (source.kind !== "open") continue;
    const due = arrivalTime(
      held(draft.index.sources, source.id, "arrival source"),
      source.next,
    );
    if (due !== time) continue;
    if (first === null || source.id < first.id) first = source;
  }
  return first;
}

function arrive(draft: Draft, time: LogicalTime, source: OpenSource): void {
  const definition = held(draft.index.sources, source.id, "arrival source");
  const workflow = held(draft.index.workflows, definition.workflow, "workflow");
  const instance = workflowInstanceId(source.id, source.next);
  draft.instances.set(instance, {
    id: instance,
    workflow: workflow.id,
    demand: workflow.demand,
    arrival: { time, source: source.id, sequence: source.next },
    carriers: [],
    lots: [],
    kind: "open",
  });
  emit(draft, time, {
    kind: "instance-arrived",
    instance,
    source: source.id,
    arrival: source.next,
  });
  for (const task of workflow.tasks) {
    const id = taskId(instance, task.key);
    draft.tasks.set(id, {
      id,
      subject: { kind: "workflow", instance, key: task.key },
      kind: "waiting",
      since: time,
      blockers: [],
    });
  }
  const next = source.next + 1;
  draft.arrivals.set(
    source.id,
    arrivalTime(definition, next) === null
      ? { id: source.id, next, kind: "exhausted" }
      : { id: source.id, next, kind: "open" },
  );
}

function dispatchOrder(draft: Draft, task: WorkflowTask): OrderKey {
  const instance = held(draft.instances, task.subject.instance, "instance");
  return {
    time: draft.time,
    phase: "dispatch",
    priority: taskDefinition(draft, instance, task.subject.key).priority,
    arrival: instance.arrival,
    task: task.id,
  };
}

function waitingInOrder(draft: Draft): WorkflowTask[] {
  const waiting: WorkflowTask[] = [];
  for (const task of draft.tasks.values())
    if (task.kind === "waiting" && isWorkflowTask(task)) waiting.push(task);
  const orders = new Map<TaskId, OrderKey>();
  for (const task of waiting) orders.set(task.id, dispatchOrder(draft, task));
  return waiting.sort(byDispatchOrder.bind(null, orders));
}

function byDispatchOrder(
  orders: ReadonlyMap<TaskId, OrderKey>,
  left: WorkflowTask,
  right: WorkflowTask,
): number {
  return compareOrder(
    held(orders, left.id, "order"),
    held(orders, right.id, "order"),
  );
}

/**
 * Starts work in dispatch order until nothing more can start. Every start
 * changes what is free, so the order is evaluated again after each one. A
 * changeover starts only when no waiting task can use its resource as it is.
 */
function dispatch(draft: Draft, time: LogicalTime): void {
  for (;;) {
    const waiting = waitingInOrder(draft);
    let started = false;
    for (const task of waiting) {
      if (blockersOf(draft, task, time).length > 0) continue;
      startTask(draft, time, task);
      started = true;
      break;
    }
    if (
      !started &&
      !startReadyBatch(draft, time, waiting) &&
      !startChangeover(draft, time, waiting)
    )
      return;
  }
}

function startReadyBatch(
  draft: Draft,
  time: LogicalTime,
  waiting: readonly WorkflowTask[],
): boolean {
  for (const candidate of waiting) {
    const executor = definitionOf(draft, candidate).executor;
    if (
      executor.kind !== "batch" ||
      !batchCanStart(draft, time, executor.resource)
    )
      continue;
    const batch = held(
      draft.resources,
      executor.resource,
      "batch resource",
    ).batch;
    if (batch?.kind !== "loading")
      throw new Error("A ready batch must be loading");
    const members: WorkflowTask[] = [];
    for (const task of waiting)
      for (const member of batch.members)
        if (
          member.task === task.id &&
          readinessBlockers(draft, task, time).length === 0
        )
          members.push(task);
    if (members.length !== batch.members.length) continue;
    beginBatch(draft, time, executor.resource);
    for (const task of members) startTask(draft, time, task);
    return true;
  }
  return false;
}

function must<Value>(result: Result<Value, QuantityError>): Value {
  // Admission checked every unit, so a mismatch here is an engine fault.
  if (!result.ok) throw new Error(`Quantity fault: ${result.error.code}`);
  return result.value;
}

function unclaimed(lot: LotState): MaterialQuantity {
  let free = lot.remaining;
  for (const claim of lot.claims)
    free = must(subtractQuantity(free, claim.quantity));
  return free;
}

/** Released lots of a product that pool claims may draw on, oldest first. */
function poolLots(draft: Draft, product: ProductId): LotState[] {
  const lots: LotState[] = [];
  for (const lot of draft.lots.values())
    if (
      lot.product === product &&
      lot.disposition === "released" &&
      lot.holder.kind === "storage"
    )
      lots.push(lot);
  return lots;
}

function freeUnits(
  definition: ResourceDefinition,
  state: ResourceState,
): number {
  let used = 0;
  for (const allocation of state.allocations) used += allocation.units;
  return definition.capacity - used;
}

function withheldAt(state: ResourceState, time: LogicalTime): boolean {
  for (const withheld of state.withheld)
    if (intervalContains(withheld.interval, time)) return true;
  return false;
}

function claimBlockers(
  draft: Draft,
  claims: readonly ResourceClaim[],
  time: LogicalTime,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const claim of claims) {
    const definition = held(draft.index.resources, claim.resource, "resource");
    const state = held(draft.resources, claim.resource, "resource");
    if (withheldAt(state, time))
      blockers.push({
        kind: "resource",
        resource: claim.resource,
        reason: "unavailable",
      });
    else if (freeUnits(definition, state) < claim.units)
      blockers.push({
        kind: "resource",
        resource: claim.resource,
        reason: state.allocations.some(isHeld) ? "held" : "capacity",
      });
    if (
      claim.configuration !== null &&
      state.configuration !== null &&
      state.configuration !== claim.configuration
    )
      blockers.push({
        kind: "configuration",
        resource: claim.resource,
        required: claim.configuration,
        current: state.configuration,
      });
  }
  return blockers;
}

function isHeld(allocation: ResourceState["allocations"][number]): boolean {
  return allocation.kind === "held";
}

/** Material in a storage position plus what executing work will add to it. */
function committedTo(draft: Draft, storage: StorageId): number {
  let amount = 0;
  for (const lot of draft.lots.values())
    if (lot.holder.kind === "storage" && lot.holder.storage === storage)
      amount += lot.remaining.amount;
  for (const task of draft.tasks.values()) {
    if (task.kind !== "executing" || !isWorkflowTask(task)) continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    for (const output of taskDefinition(draft, instance, task.subject.key)
      .outputs)
      if (
        (output.kind === "lot" || output.kind === "measured-lot") &&
        output.holder.kind === "storage" &&
        output.holder.storage === storage
      )
        amount += outputCeiling(output).amount;
  }
  return amount;
}

function ownLot(
  draft: Draft,
  instance: WorkflowInstanceState,
  key: Variant<TaskDefinition["inputs"][number], "lot">["lot"],
): LotState {
  for (const lot of instance.lots)
    if (lot.key === key) return held(draft.lots, lot.lot, "lot");
  throw new Error(`Instance ${instance.id} has not produced lot ${key}`);
}

/** Everything that stops a waiting task from starting now. Empty means go. */
function blockersOf(
  draft: Draft,
  task: WorkflowTask,
  time: LogicalTime,
): Blocker[] {
  const blockers = readinessBlockers(draft, task, time);
  return blockers.length > 0 ? blockers : batchBlockers(draft, task, time);
}

function readinessBlockers(
  draft: Draft,
  task: WorkflowTask,
  time: LogicalTime,
): Blocker[] {
  const instance = held(draft.instances, task.subject.instance, "instance");
  const definition = taskDefinition(draft, instance, task.subject.key);
  const blockers: Blocker[] = [];
  const releaseAt = later(instance.arrival.time, definition.releaseAfter);
  if (time < releaseAt) blockers.push({ kind: "release", at: releaseAt });
  for (const key of definition.prerequisites) {
    const prerequisite = taskId(instance.id, key);
    if (!taskFinished(held(draft.tasks, prerequisite, "task")))
      blockers.push({ kind: "prerequisite", task: prerequisite });
  }
  for (const prerequisite of draft.index.dependencies.get(task.id) ?? []) {
    if (!taskFinished(draft.tasks.get(prerequisite)))
      blockers.push({ kind: "prerequisite", task: prerequisite });
  }
  // An unreleased task claims nothing and cannot trigger a changeover.
  // Material a later task consumes cannot be claimed before it exists.
  if (blockers.length > 0) return blockers;
  if (skipDecision(draft, instance, definition) !== null) return [];
  if (
    definition.executor.kind === "inspection" &&
    decisionOutcome(draft, instance, task.subject.key) === null
  )
    blockers.push({ kind: "inspection", task: task.id });
  blockers.push(...claimBlockers(draft, definition.claims, time));
  const work = executionWork(definition.executor);
  if (work.kind === "attended" && availableWorker(draft, work, time) === null)
    blockers.push({ kind: "workers", workers: work.workers });

  const pooled = new Map<ProductId, MaterialQuantity>();
  for (const input of definition.inputs) {
    if (input.kind === "pool") {
      const total = pooled.get(input.product);
      pooled.set(
        input.product,
        total === undefined
          ? input.quantity
          : must(addQuantity(total, input.quantity)),
      );
      continue;
    }
    const lot = ownLot(draft, instance, input.lot);
    const free =
      lot.disposition === "released"
        ? unclaimed(lot)
        : zeroQuantity(lot.remaining.unit);
    if (free.amount < input.quantity.amount)
      blockers.push({
        kind: "material",
        product: lot.product,
        missing: must(subtractQuantity(input.quantity, free)),
      });
  }
  for (const [product, required] of pooled) {
    let free = zeroQuantity(required.unit);
    for (const lot of poolLots(draft, product))
      free = must(addQuantity(free, unclaimed(lot)));
    if (free.amount < required.amount)
      blockers.push({
        kind: "material",
        product,
        missing: must(subtractQuantity(required, free)),
      });
  }
  blockers.push(...carrierBlockers(draft, definition));

  const adding = new Map<StorageId, number>();
  for (const output of definition.outputs)
    if (output.kind === "lot" && output.holder.kind === "storage")
      adding.set(
        output.holder.storage,
        (adding.get(output.holder.storage) ?? 0) + output.quantity.amount,
      );
  for (const [storage, amount] of adding) {
    const capacity = held(draft.index.storages, storage, "storage").capacity;
    if (
      capacity.kind === "material" &&
      committedTo(draft, storage) + amount > capacity.quantity.amount
    )
      blockers.push({ kind: "destination", storage });
  }
  return blockers;
}

function allocate(
  draft: Draft,
  time: LogicalTime,
  task: TaskId,
  claims: readonly ResourceClaim[],
): void {
  for (const claim of claims) {
    claimResource(draft, time, claim.resource, task, "occupied", claim.units);
  }
}

function claimLot(
  draft: Draft,
  lot: LotState,
  task: TaskId,
  quantity: MaterialQuantity,
): void {
  draft.lots.set(lot.id, {
    ...lot,
    claims: [...lot.claims, { task, quantity }],
  });
}

/**
 * Binds a native operation to the exact state its cell is in. Its duration
 * is unknown until the controller evidences it.
 */
function dispatchNative(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  operation: NativeOperation,
): AttemptId {
  wake(draft, operation.cell, time);
  const cell = held(draft.cells, operation.cell, "cell");
  if (cell.attempt !== null || cell.committed.boundary !== time)
    throw new Error(`Cell ${cell.id} cannot take ${task.id} now`);
  // A retry would take the next number; this increment issues the first.
  const attempt = attemptId(task.id, 1);
  draft.cells.set(cell.id, {
    ...cell,
    attempt: {
      id: attempt,
      task: task.id,
      dispatchedAt: time,
      startingCheckpoint: cell.committed.checkpoint.digest,
      origin: { kind: "original" },
      lifecycle: { kind: "dispatched" },
      steps: ZERO_STEPS,
      segments: [],
    },
  });
  return attempt;
}

/**
 * Allocates a task's resources, material and carrier positions together and
 * starts it. A declared duration fixes its completion now; a native
 * operation completes when its controller evidences it.
 */
function startTask(draft: Draft, time: LogicalTime, task: WorkflowTask): void {
  const instance = held(draft.instances, task.subject.instance, "instance");
  const definition = taskDefinition(draft, instance, task.subject.key);
  const decision = skipDecision(draft, instance, definition);
  if (decision !== null) {
    draft.tasks.set(task.id, {
      id: task.id,
      subject: task.subject,
      kind: "skipped",
      completedAt: time,
      inspection: decision.task,
      outcome: decision.outcome,
    });
    emit(draft, time, {
      kind: "task-skipped",
      task: task.id,
      inspection: decision.task,
      outcome: decision.outcome,
    });
    completeInstance(draft, time, instance);
    return;
  }
  allocate(draft, time, task.id, definition.claims);
  for (const input of definition.inputs) {
    if (input.kind === "lot") {
      claimLot(
        draft,
        ownLot(draft, instance, input.lot),
        task.id,
        input.quantity,
      );
      continue;
    }
    let needed = input.quantity;
    for (const candidate of poolLots(draft, input.product)) {
      if (needed.amount === 0) break;
      // Read again: an earlier input of this task may have claimed from it.
      const lot = held(draft.lots, candidate.id, "lot");
      const free = unclaimed(lot);
      if (free.amount === 0) continue;
      const taken = free.amount < needed.amount ? free : needed;
      claimLot(draft, lot, task.id, taken);
      needed = must(subtractQuantity(needed, taken));
    }
    if (needed.amount > 0)
      throw new Error(`Task ${task.id} started without its material`);
  }
  const executor = executionWork(definition.executor);
  const workAt =
    executor.kind === "attended"
      ? assignWorker(draft, time, task.id, executor)
      : time;
  const attempt =
    executor.kind === "native"
      ? dispatchNative(draft, time, task, executor.operation)
      : null;
  let completesAt: LogicalTime | null;
  switch (executor.kind) {
    case "inspection": {
      completesAt = time;
      if (executor.rule !== undefined) {
        const outcome = decisionOutcome(draft, instance, task.subject.key);
        if (outcome === null) throw new Error("A rule gave no decision");
        emit(draft, time, { kind: "decision-taken", task: task.id, outcome });
      }
      break;
    }
    case "native":
      completesAt = null;
      break;
    case "declared":
    case "attended":
      completesAt = later(workAt, executor.duration);
      break;
    case "batch": {
      const batch = held(
        draft.resources,
        executor.resource,
        "batch resource",
      ).batch;
      if (batch?.kind !== "running")
        throw new Error("A batch task needs a running cycle");
      completesAt = batch.completesAt;
      allocate(draft, time, task.id, [
        { resource: executor.resource, units: 1, configuration: null },
      ]);
      break;
    }
    default:
      assertNever(executor, "Unexpected executor");
  }
  draft.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    kind: "executing",
    startedAt: time,
    attempt,
    completesAt,
  });
  emit(draft, time, { kind: "task-started", task: task.id, attempt });
  bindCarriers(draft, time, workAt, task, definition);
  admitBatchLoad(draft, time, task);
  if (completesAt === null) return;
  // A zero-duration task commits inside this timestamp's dispatch closure.
  // One that moves a carrier settles its boundaries in order instead.
  if (completesAt === time && definition.carriers.length === 0) {
    completeTask(draft, time, task, time, null, []);
    return;
  }
  draft.scheduled.push({
    kind: "task-boundary",
    task: task.id,
    carrierStep: null,
    order: {
      time: completesAt,
      phase: "settle",
      origin: "declared",
      arrival: instance.arrival,
      task: task.id,
      boundary: "completion",
    },
  });
}

/**
 * The accepted boundary of a task: its inputs are consumed, its outputs and
 * releases recorded and its resources freed, together and once. A measured
 * output takes the quantity its controller measured.
 */
function completeTask(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  startedAt: LogicalTime,
  attempt: AttemptId | null,
  measurements: readonly Measurement[],
): void {
  let instance = held(draft.instances, task.subject.instance, "instance");
  const definition = taskDefinition(draft, instance, task.subject.key);
  finishWorker(draft, time, task.id);
  releaseTaskResources(draft, time, task.id);

  const consumed: LotId[] = [];
  for (const lot of [...draft.lots.values()]) {
    let remaining = lot.remaining;
    const kept: LotState["claims"][number][] = [];
    for (const claim of lot.claims) {
      if (claim.task !== task.id) {
        kept.push(claim);
        continue;
      }
      remaining = must(subtractQuantity(remaining, claim.quantity));
      emit(draft, time, {
        kind: "lot-consumed",
        lot: lot.id,
        quantity: claim.quantity,
        task: task.id,
      });
    }
    if (kept.length === lot.claims.length) continue;
    consumed.push(lot.id);
    draft.lots.set(lot.id, { ...lot, remaining, claims: kept });
  }

  for (const declared of definition.outputs) {
    const output = measuredOutput(
      resolvedOutput(draft, instance, declared),
      measurements,
    );
    if (output.kind === "exit") {
      emit(draft, time, {
        kind: "quantity-reported",
        destination: output.destination,
        role: held(draft.index.destinations, output.destination, "destination")
          .role,
        product: output.product,
        quantity: output.quantity,
        task: task.id,
      });
      continue;
    }
    const holder: LotState["holder"] =
      output.holder.kind === "storage"
        ? { kind: "storage", storage: output.holder.storage }
        : {
            kind: "carrier",
            carrier: boundCarrier(draft, instance, output.holder.carrier).id,
          };
    const lot = instanceLotId(instance.id, output.lot);
    draft.lots.set(lot, {
      id: lot,
      product: output.product,
      remaining: output.quantity,
      claims: [],
      lineage: consumed,
      origin: { kind: "produced", task: task.id, at: time },
      disposition: output.disposition,
      holder,
    });
    instance = {
      ...instance,
      lots: [...instance.lots, { key: output.lot, lot }],
    };
    draft.instances.set(instance.id, instance);
    emit(draft, time, {
      kind: "lot-produced",
      lot,
      product: output.product,
      quantity: output.quantity,
      task: task.id,
    });
    // Intermediate stock is counted once, here, and stays claimable.
    if (output.report !== null)
      emit(draft, time, {
        kind: "quantity-reported",
        destination: output.report,
        role: held(draft.index.destinations, output.report, "destination").role,
        product: output.product,
        quantity: output.quantity,
        task: task.id,
      });
  }

  for (const key of definition.releases) {
    const lot = ownLot(draft, instance, key);
    draft.lots.set(lot.id, { ...lot, disposition: "released" });
    emit(draft, time, { kind: "lot-released", lot: lot.id, task: task.id });
  }

  releaseCarriers(draft, time, task, definition);
  instance = held(draft.instances, instance.id, "instance");
  draft.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    kind: "completed",
    startedAt,
    completedAt: time,
  });
  emit(draft, time, { kind: "task-completed", task: task.id, attempt });

  completeInstance(draft, time, instance);
}

function taskFinished(task: TaskState | undefined): boolean {
  return task?.kind === "completed" || task?.kind === "skipped";
}

/** An operator's recorded decision, or what the decision's rule gives. */
function decisionOutcome(
  draft: Draft,
  instance: WorkflowInstanceState,
  key: TaskKey,
): DecisionOutcome | null {
  const recorded = inspectionDecision(draft.commands, taskId(instance.id, key));
  if (recorded !== null) return recorded.outcome;
  const executor = taskDefinition(draft, instance, key).executor;
  if (executor.kind !== "inspection" || executor.rule === undefined)
    return null;
  const outcome = ruleOutcome(
    executor.rule,
    { id: instance.id, sequence: instance.arrival.sequence },
    draft.events,
  );
  if (outcome === null) throw new Error("A measurement rule needs its lot");
  return outcome;
}

/** The decision that skips a task, or null when the task runs. */
function skipDecision(
  draft: Draft,
  instance: WorkflowInstanceState,
  definition: TaskDefinition,
): Readonly<{ task: TaskId; outcome: DecisionOutcome }> | null {
  const executor = definition.executor;
  const guard =
    executor.kind === "after-inspection"
      ? { inspection: executor.inspection, outcome: executor.outcome }
      : executor.kind === "inspection"
        ? (executor.when ?? null)
        : null;
  if (guard === null) return null;
  const gate = taskId(instance.id, guard.inspection);
  // A decision inside a skipped branch was not taken. Its branches skip with it.
  const state = draft.tasks.get(gate);
  if (state?.kind === "skipped")
    return { task: state.inspection, outcome: state.outcome };
  const outcome = decisionOutcome(draft, instance, guard.inspection);
  if (outcome === null)
    throw new Error("A conditional task needs its inspection decision");
  return outcome === guard.outcome ? null : { task: gate, outcome };
}

function completeInstance(
  draft: Draft,
  time: LogicalTime,
  instance: WorkflowInstanceState,
): void {
  for (const key of held(
    draft.index.tasks,
    instance.workflow,
    "workflow",
  ).keys())
    if (!taskFinished(held(draft.tasks, taskId(instance.id, key), "task")))
      return;
  draft.instances.set(instance.id, {
    id: instance.id,
    workflow: instance.workflow,
    demand: instance.demand,
    arrival: instance.arrival,
    carriers: instance.carriers,
    lots: instance.lots,
    kind: "completed",
    completedAt: time,
  });
  // An order counts once, when all its work is done, whatever its task count.
  if (instance.demand === "order")
    emit(draft, time, { kind: "order-completed", instance: instance.id });
}

/** A measured output as the declared output its measurement makes it. */
function measuredOutput(
  output: Exclude<
    import("./scenario.ts").MaterialOutput,
    { kind: "inspection-exit" }
  >,
  measurements: readonly Measurement[],
): Extract<import("./scenario.ts").MaterialOutput, { kind: "lot" | "exit" }> {
  if (output.kind === "lot" || output.kind === "exit") return output;
  const found = measurements.find(
    (measurement) => measurement.measurement === output.measurement,
  );
  if (found === undefined)
    throw new Error(`Measurement ${output.measurement} is missing`);
  if (output.kind === "measured-exit")
    return {
      kind: "exit",
      product: output.product,
      quantity: found.quantity,
      destination: output.destination,
    };
  return {
    kind: "lot",
    lot: output.lot,
    product: output.product,
    quantity: found.quantity,
    holder: output.holder,
    disposition: output.disposition,
    report: output.report,
  };
}

/**
 * Whether a completion's measurements fit its task: one for each measured
 * output, within its bound and unit, and together equal to the consumed
 * inputs. A task without measured outputs takes no measurements.
 */
export function measurementsFit(
  definition: TaskDefinition,
  measurements: readonly Measurement[],
): boolean {
  const measured = definition.outputs.filter(
    (output) =>
      output.kind === "measured-lot" || output.kind === "measured-exit",
  );
  if (measured.length !== measurements.length) return false;
  if (measured.length === 0) return true;
  let total = 0;
  for (const output of measured) {
    const found = measurements.filter(
      (measurement) => measurement.measurement === output.measurement,
    );
    const quantity = found[0]?.quantity;
    if (
      found.length !== 1 ||
      quantity === undefined ||
      quantity.unit !== output.bound.unit ||
      quantity.amount > output.bound.amount
    )
      return false;
    total += quantity.amount;
  }
  let consumed = 0;
  for (const input of definition.inputs) consumed += input.quantity.amount;
  return total === consumed;
}

function resolvedOutput(
  draft: Draft,
  instance: WorkflowInstanceState,
  output: import("./scenario.ts").MaterialOutput,
): Exclude<
  import("./scenario.ts").MaterialOutput,
  { kind: "inspection-exit" }
> {
  if (output.kind !== "inspection-exit") return output;
  let accepted = true;
  for (const key of output.inspections) {
    const outcome = decisionOutcome(draft, instance, key);
    if (outcome === null)
      throw new Error("A product cannot leave without its inspection");
    if (outcome === "reject") accepted = false;
  }
  return {
    kind: "exit",
    product: accepted ? output.product : output.rejectedProduct,
    destination: accepted ? output.destination : output.rejectedDestination,
    quantity: output.quantity,
  };
}

/** The first declared changeover on a shortest path to `required`. */
function firstChangeover(
  definition: ResourceDefinition,
  current: ConfigurationId,
  required: ConfigurationId,
): Changeover | null {
  const changeovers = definition.configuration?.changeovers ?? [];
  const first = new Map<ConfigurationId, Changeover>();
  const queue: ConfigurationId[] = [current];
  for (let from = queue.shift(); from !== undefined; from = queue.shift())
    for (const changeover of changeovers) {
      if (changeover.from !== from) continue;
      if (changeover.to === current || first.has(changeover.to)) continue;
      first.set(changeover.to, first.get(from) ?? changeover);
      queue.push(changeover.to);
    }
  return first.get(required) ?? null;
}

/**
 * Starts one changeover as a task of its own. It needs an idle resource and a
 * waiting task whose only blockers are configurations, so a changeover never
 * pre-empts work the resource could do as it is.
 */
function startChangeover(
  draft: Draft,
  time: LogicalTime,
  waiting: readonly WorkflowTask[],
): boolean {
  for (const cause of waiting) {
    const blockers = blockersOf(draft, cause, time);
    if (blockers.length === 0 || !blockers.every(isConfiguration)) continue;
    for (const blocker of blockers) {
      if (blocker.kind !== "configuration") continue;
      const definition = held(
        draft.index.resources,
        blocker.resource,
        "resource",
      );
      const resource = held(draft.resources, blocker.resource, "resource");
      if (resource.allocations.length > 0 || withheldAt(resource, time))
        continue;
      const changeover = firstChangeover(
        definition,
        blocker.current,
        blocker.required,
      );
      if (changeover === null) continue;
      if (claimBlockers(draft, changeover.claims, time).length > 0) continue;
      runChangeover(draft, time, cause, definition, resource, changeover);
      return true;
    }
  }
  return false;
}

function isConfiguration(blocker: Blocker): boolean {
  return blocker.kind === "configuration";
}

function runChangeover(
  draft: Draft,
  time: LogicalTime,
  cause: WorkflowTask,
  definition: ResourceDefinition,
  resource: ResourceState,
  changeover: Changeover,
): void {
  const sequence = resource.changeovers + 1;
  const id = changeoverTaskId(resource.id, sequence);
  draft.resources.set(resource.id, { ...resource, changeovers: sequence });
  // The changeover holds its whole resource, whatever its capacity.
  allocate(draft, time, id, [
    { resource: resource.id, units: definition.capacity, configuration: null },
    ...changeover.claims,
  ]);
  const completesAt = later(time, changeover.duration);
  const task: TaskState = {
    id,
    subject: {
      kind: "changeover",
      resource: resource.id,
      from: changeover.from,
      to: changeover.to,
      cause: cause.id,
    },
    kind: "executing",
    startedAt: time,
    attempt: null,
    completesAt,
  };
  draft.tasks.set(id, task);
  emit(draft, time, { kind: "task-started", task: id, attempt: null });
  if (completesAt === time) {
    completeChangeover(draft, time, task, time);
    return;
  }
  draft.scheduled.push({
    kind: "task-boundary",
    task: id,
    carrierStep: null,
    order: {
      time: completesAt,
      phase: "settle",
      origin: "declared",
      arrival: arrivalOf(draft, task),
      task: id,
      boundary: "completion",
    },
  });
}

function completeChangeover(
  draft: Draft,
  time: LogicalTime,
  task: TaskState,
  startedAt: LogicalTime,
): void {
  const subject = task.subject;
  if (subject.kind !== "changeover")
    throw new Error(`Task ${task.id} is not a changeover`);
  releaseTaskResources(draft, time, task.id);
  const resource = held(draft.resources, subject.resource, "resource");
  draft.resources.set(resource.id, { ...resource, configuration: subject.to });
  emit(draft, time, {
    kind: "configuration-changed",
    resource: resource.id,
    from: subject.from,
    to: subject.to,
    task: task.id,
  });
  draft.tasks.set(task.id, {
    id: task.id,
    subject,
    kind: "completed",
    startedAt,
    completedAt: time,
  });
  emit(draft, time, { kind: "task-completed", task: task.id, attempt: null });
}
