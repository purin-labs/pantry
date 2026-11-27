import type { Variant } from "@purin-labs/type-utils";
import { canonicalJson, sha256HexSync, utf8ByteLength } from "@purin-labs/std";
import { slotAfter } from "../engine-carriers.ts";
import {
  acceptRest,
  acceptSegment,
  acceptStart,
  acceptTerminal,
  supplyBoundary,
  type EvidenceRejection,
} from "../engine-physics.ts";
import { advanceRun, startRun, type EngineError } from "../engine.ts";
import {
  parseId,
  parseSha256Hex,
  type CellId,
  type Sha256Hex,
  type TaskId,
} from "../identity.ts";
import type {
  AttemptAddress,
  BoundaryCandidate,
  CarrierDisposition,
  CheckpointRef,
  ExecutionNeed,
  Segment,
  Terminal,
} from "../physics.ts";
import { err, ok, type Result } from "../result.ts";
import type { CellState, RunState } from "../state.ts";
import {
  TICK_MICROSECONDS,
  ZERO_TIME,
  elapsed,
  type LogicalTime,
  type StepCount,
} from "../time.ts";
import type { BakeStep, CompiledBakeRun } from "./compile.ts";
import {
  dispatchOfTask,
  emptyLedger,
  ingestEvidence,
  terminalReport,
  type DispatchRecord,
  type EvidenceDisposition,
  type EvidenceLedger,
} from "./evidence.ts";
import {
  dispatchIdentity,
  type ClockOrigin,
  type CobotTaskMessage,
  type PhysicalEvidence,
} from "./protocol.ts";

/**
 * The physical execution adapter. It answers each need of the engine only
 * from accepted evidence: the dispatch records the caller wrote and the
 * receipts and clocks of the devices. Logical time is device time since the
 * run's clock origin, on the engine tick. Where evidence is missing the loop
 * stops and names what it waits for; it never invents a step, a pickup or a
 * position.
 */

export type PhysicalRun = Readonly<{
  bake: CompiledBakeRun;
  run: RunState;
  ledger: EvidenceLedger;
  /** The native events already given to the engine, by dispatch. */
  applied: Readonly<
    Record<string, Readonly<{ pickup: boolean; placement: boolean }>>
  >;
}>;

/** Why the loop returned, and what the caller does next. */
export type PhysicalWait =
  /** Send this task. Write the message as a dispatch record first. */
  | Readonly<{ kind: "dispatch"; step: string; message: CobotTaskMessage }>
  /** The run waits for a receipt or for device time of this dispatch. */
  | Readonly<{
      kind: "evidence";
      step: string;
      requestId: string;
      sourceKey: string;
      awaiting: "receipt" | "clock";
    }>
  /** An attempt failed. A person settles it; no dispatch follows. */
  | Readonly<{
      kind: "disposition";
      step: string;
      requestId: string;
      sourceKey: string;
      carrierAt: CarrierDisposition;
      reason: string;
    }>
  | Readonly<{ kind: "completed"; at: LogicalTime }>
  /** The run reached the caller's bound. */
  | Readonly<{ kind: "until"; at: LogicalTime }>
  | Readonly<{ kind: "engine"; status: RunState["status"]["kind"] }>
  /** The engine refused an answer built from evidence: a defect to inspect. */
  | Readonly<{
      kind: "rejected";
      need: ExecutionNeed["kind"];
      reason: EvidenceRejection | "slot_forbids_boundary";
    }>;

export type PhysicalStop = Readonly<{
  run: PhysicalRun;
  dispositions: readonly EvidenceDisposition[];
  stop: PhysicalWait;
}>;

export type PhysicalStartProblem =
  | Readonly<{ code: "invalid_identity"; field: string }>
  | Readonly<{ code: "missing_origin"; sourceKey: string }>
  | Readonly<{ code: "engine"; error: EngineError }>;

const TICK = TICK_MICROSECONDS;

function digestOf(content: string): Sha256Hex {
  const parsed = parseSha256Hex(sha256HexSync(content));
  if (!parsed.ok) throw new Error("A SHA-256 digest has an invalid form");
  return parsed.value;
}

/** A device state that receipts evidence, named by what evidences it. */
function checkpointAt(
  cell: CellId,
  step: StepCount,
  basis: unknown,
): CheckpointRef {
  const content = canonicalJson({ cell, step, basis });
  return {
    digest: digestOf(content),
    byteLength: utf8ByteLength(content),
    step,
  };
}

/** The physical protocol, pinned where a simulated run pins its bundle. */
const PHYSICAL_BUNDLE_ID: Sha256Hex = digestOf(
  canonicalJson({ protocol: "plan-24-cobot/1", adapter: "physical/1" }),
);

/** Starts one approved bake run with each device clock at logical zero. */
export function startPhysicalRun(
  bake: CompiledBakeRun,
  execution: Readonly<{ executionId: string; hostSession: string }>,
  origin: ClockOrigin,
): Result<PhysicalRun, PhysicalStartProblem> {
  const executionId = parseId("execution", execution.executionId);
  if (!executionId.ok)
    return err({ code: "invalid_identity", field: "executionId" });
  const hostSession = parseId("host-session", execution.hostSession);
  if (!hostSession.ok)
    return err({ code: "invalid_identity", field: "hostSession" });
  const clocks: Record<string, number> = {};
  for (const { sourceKey } of bake.cells) {
    const clock = origin[sourceKey];
    if (clock === undefined || !Number.isSafeInteger(clock) || clock < 0)
      return err({ code: "missing_origin", sourceKey });
    clocks[sourceKey] = clock;
  }
  const started = startRun(
    bake.definition,
    {
      runId: bake.runId,
      executionId: executionId.value,
      hostSession: hostSession.value,
      bundle: PHYSICAL_BUNDLE_ID,
      parent: null,
    },
    bake.cells.map(({ cell }) => ({
      cell,
      checkpoint: checkpointAt(cell, 0 as StepCount, "opened"),
    })),
  );
  if (!started.ok) return err({ code: "engine", error: started.error });
  return ok({
    bake,
    run: started.value,
    ledger: emptyLedger(clocks),
    applied: {},
  });
}

function sourceOf(physical: PhysicalRun, cell: CellId): string {
  for (const entry of physical.bake.cells)
    if (entry.cell === cell) return entry.sourceKey;
  throw new Error(`Cell ${cell} has no device`);
}

function stepOf(physical: PhysicalRun, task: TaskId): BakeStep {
  for (const step of physical.bake.steps)
    if (step.engineTask === task) return step;
  throw new Error(`Task ${task} has no protocol step`);
}

function recordOf(physical: PhysicalRun, task: TaskId): DispatchRecord | null {
  return dispatchOfTask(physical.ledger, task);
}

/** A native attempt that ended failed, before a person settles it. */
export function isFailedTask(
  task: RunState["tasks"][number],
): task is Variant<
  RunState["tasks"][number],
  "recovery-required" | "recovering" | "recovery-failed" | "failed"
> {
  return (
    task.kind === "recovery-required" ||
    task.kind === "recovering" ||
    task.kind === "recovery-failed" ||
    task.kind === "failed"
  );
}

function cellOf(run: RunState, cell: CellId): CellState {
  for (const state of run.cells) if (state.id === cell) return state;
  throw new Error(`Run has no cell ${cell}`);
}

/** Device time since the run's origin, on the engine tick. */
function logicalOf(
  ledger: EvidenceLedger,
  sourceKey: string,
  clockMs: number,
): LogicalTime {
  const micros = (clockMs - (ledger.origin[sourceKey] ?? 0)) * 1_000;
  return (Math.floor(micros / TICK) * TICK) as LogicalTime;
}

function frontier(ledger: EvidenceLedger, sourceKey: string): LogicalTime {
  const device = ledger.devices[sourceKey];
  return logicalOf(ledger, sourceKey, device?.clockMs ?? 0);
}

function stepsSince(from: LogicalTime, to: LogicalTime): StepCount {
  return (to <= from ? 0 : elapsed(from, to) / TICK) as StepCount;
}

type CarrierEvent = "pickup" | "placement";

type Mark = Readonly<{
  time: LogicalTime;
  events: readonly CarrierEvent[];
  terminal: Readonly<{
    outcome: "completed" | "failed";
    disposition: CarrierDisposition;
  }> | null;
}>;

/**
 * What the dispatch's receipts evidence next, in controller order. A pickup
 * is the first report with the group on the tool or beyond; a placement is
 * the first report of the group at its destination. A failure keeps the
 * position the report gives, and `unknown` when it gives none. Reports at
 * one engine tick form one mark.
 */
function nextMark(
  physical: PhysicalRun,
  record: DispatchRecord,
  moves: boolean,
): Mark | null {
  const ledger = physical.ledger;
  let { pickup, placement } = physical.applied[record.requestId] ?? {
    pickup: false,
    placement: false,
  };
  let mark = null as Mark | null;
  for (const report of record.reports) {
    const time = logicalOf(ledger, report.sourceKey, report.deviceClockMs);
    if (mark !== null && time !== mark.time) return mark;
    const events: CarrierEvent[] = [...(mark?.events ?? [])];
    const ended = report.state === "completed";
    const reached = report.carrierAt === "destination" || ended;
    if (moves && !pickup && (report.carrierAt === "tool" || reached)) {
      events.push("pickup");
      pickup = true;
    }
    const placing = report.state === "running" || ended;
    if (moves && !placement && placing && reached) {
      events.push("placement");
      placement = true;
    }
    const failed =
      report.state === "rejected" || report.state === "indeterminate";
    const ending: Mark["terminal"] =
      ended || failed
        ? {
            outcome: ended ? "completed" : "failed",
            disposition: ended
              ? "destination"
              : (report.carrierAt ?? "unknown"),
          }
        : (mark?.terminal ?? null);
    if (events.length > 0 || ending !== null)
      mark = { time, events, terminal: ending };
  }
  if (mark !== null) return mark;
  if (record.lost !== null)
    return {
      time: logicalOf(ledger, record.sourceKey, record.lost.clockMs),
      events: [],
      terminal: { outcome: "failed", disposition: "unknown" },
    };
  return null;
}

/**
 * The last engine tick whose evidence is complete. Device time at T proves
 * the ticks before T; a report may still come at T itself, unless the
 * dispatch has ended and no further report of it can come.
 */
function closedStep(
  physical: PhysicalRun,
  record: DispatchRecord,
  dispatchedAt: LogicalTime,
): number {
  if (record.lost !== null || terminalReport(record) !== null)
    return Number.POSITIVE_INFINITY;
  const reached = frontier(physical.ledger, record.sourceKey);
  return stepsSince(dispatchedAt, reached) - 1;
}

type Answer =
  | Readonly<{ kind: "next"; physical: PhysicalRun }>
  | Readonly<{ kind: "stop"; physical: PhysicalRun; stop: PhysicalWait }>;

function next(physical: PhysicalRun, run: RunState): Answer {
  return { kind: "next", physical: { ...physical, run } };
}

function accepted(
  physical: PhysicalRun,
  need: ExecutionNeed["kind"],
  result: Result<RunState, EvidenceRejection>,
): Answer {
  return result.ok
    ? next(physical, result.value)
    : {
        kind: "stop",
        physical,
        stop: { kind: "rejected", need, reason: result.error },
      };
}

/** The failed attempt a person must settle, if one is open. */
export function openDisposition(physical: PhysicalRun): PhysicalWait | null {
  for (const task of physical.run.tasks) {
    if (!isFailedTask(task)) continue;
    const step = stepOf(physical, task.id);
    const record = recordOf(physical, task.id);
    const report = record === null ? null : terminalReport(record);
    return {
      kind: "disposition",
      step: step.key,
      requestId: record?.requestId ?? "",
      sourceKey: step.sourceKey,
      carrierAt: task.disposition,
      reason:
        report === null
          ? "report_lost"
          : (report.reason ?? `controller_${report.state}`),
    };
  }
  return null;
}

function dispatchMessage(
  physical: PhysicalRun,
  step: BakeStep,
  attempt: string,
): CobotTaskMessage {
  const identity = physical.run.identity;
  return {
    type: "cobot_task",
    requestId: dispatchIdentity(identity.runId, identity.executionId, attempt),
    sourceKey: step.sourceKey,
    runId: identity.runId,
    taskId: step.engineTask,
    task: step.task,
  };
}

function terminal(
  address: AttemptAddress,
  attempt: NonNullable<CellState["attempt"]>,
  cell: CellState,
  mark: NonNullable<Mark["terminal"]>,
): Terminal {
  const base = {
    ...address,
    kind: "terminal" as const,
    sequence: attempt.segments.length,
    steps: attempt.steps,
    segments: attempt.segments.map((_, index) => index),
  };
  return mark.outcome === "completed"
    ? {
        ...base,
        outcome: "completed",
        checkpoint: cell.committed.checkpoint,
        measurements: [],
      }
    : {
        ...base,
        outcome: "failed",
        disposition: mark.disposition,
        checkpoint: cell.committed.checkpoint,
      };
}

function answerStart(
  physical: PhysicalRun,
  need: Variant<ExecutionNeed, "start">,
): Answer {
  const dispatch = need.dispatch;
  const step = stepOf(physical, dispatch.task);
  const failure = openDisposition(physical);
  if (failure !== null) return { kind: "stop", physical, stop: failure };
  const record = recordOf(physical, dispatch.task);
  if (record === null)
    return {
      kind: "stop",
      physical,
      stop: {
        kind: "dispatch",
        step: step.key,
        message: dispatchMessage(physical, step, dispatch.attemptId),
      },
    };
  const first = record.reports[0];
  if (first === undefined)
    return {
      kind: "stop",
      physical,
      stop: {
        kind: "evidence",
        step: step.key,
        requestId: record.requestId,
        sourceKey: record.sourceKey,
        awaiting: "receipt",
      },
    };
  if (first.state !== "rejected")
    return accepted(
      physical,
      "start",
      acceptStart(physical.run, dispatch, { kind: "started" }),
    );
  // The controller refused the plan before any motion.
  const cell = cellOf(physical.run, dispatch.cellId);
  return accepted(
    physical,
    "start",
    acceptStart(physical.run, dispatch, {
      kind: "refused",
      terminal: {
        runId: dispatch.runId,
        executionId: dispatch.executionId,
        cellId: dispatch.cellId,
        attemptId: dispatch.attemptId,
        kind: "terminal",
        sequence: 0,
        steps: 0 as StepCount,
        segments: [],
        outcome: "failed",
        disposition: first.carrierAt ?? "unknown",
        checkpoint: cell.committed.checkpoint,
      },
    }),
  );
}

function answerAdvance(
  physical: PhysicalRun,
  need: Variant<ExecutionNeed, "advance">,
): Answer {
  const run = physical.run;
  const cell = cellOf(run, need.attempt.cellId);
  const attempt = cell.attempt;
  if (attempt === null) throw new Error("An advance needs an attempt");
  const step = stepOf(physical, attempt.task);
  const record = recordOf(physical, attempt.task);
  if (record === null) throw new Error("A started attempt has no dispatch");
  const s0 = attempt.steps;
  const limit = (s0 + need.steps) as StepCount;
  const mark = nextMark(physical, record, step.kind !== "bake");
  const closed = closedStep(physical, record, attempt.dispatchedAt);
  let end = Math.min(closed, limit);
  let events: readonly CarrierEvent[] = [];
  if (mark !== null && mark.events.length > 0) {
    // Each event lies at least one step after the accepted boundary.
    const at = Math.max(stepsSince(attempt.dispatchedAt, mark.time), s0 + 1);
    if (at <= end) {
      end = at;
      events = mark.events;
    }
  } else if (mark !== null && mark.terminal !== null) {
    const at = Math.max(stepsSince(attempt.dispatchedAt, mark.time), s0);
    if (at === s0)
      return accepted(
        physical,
        "advance",
        acceptTerminal(
          run,
          terminal(need.attempt, attempt, cell, mark.terminal),
        ),
      );
    end = Math.min(at, end);
  }
  if (end <= s0)
    return {
      kind: "stop",
      physical,
      stop: {
        kind: "evidence",
        step: step.key,
        requestId: record.requestId,
        sourceKey: record.sourceKey,
        awaiting: record.reports.length === 0 ? "receipt" : "clock",
      },
    };
  // The state at a step is named by the receipts up to that step, so the
  // same receipts give the same checkpoint however they were batched.
  const endTime = attempt.dispatchedAt + end * TICK;
  const segmentEnd = end as StepCount;
  const basis: number[] = [];
  for (const report of record.reports)
    if (
      logicalOf(physical.ledger, report.sourceKey, report.deviceClockMs) <=
      endTime
    )
      basis.push(report.sequence);
  const definition = run.definition.scenario.cells.find(
    (candidate) => candidate.id === cell.id,
  );
  if (definition === undefined || run.identity.bundle === null)
    throw new Error("A physical cell needs its definition and bundle");
  const checkpoint = checkpointAt(
    cell.id,
    (cell.committed.checkpoint.step + (segmentEnd - s0)) as StepCount,
    { attempt: attempt.id, step: segmentEnd, basis },
  );
  const recording = canonicalJson({
    requestId: record.requestId,
    basis,
    end: segmentEnd,
  });
  const segment: Segment = {
    ...need.attempt,
    kind: "segment",
    sequence: attempt.segments.length,
    predecessor: cell.committed.checkpoint.digest,
    steps: { start: s0, end: segmentEnd },
    bundle: run.identity.bundle,
    modelHash: definition.modelHash,
    events: events.map((kind, order) => ({
      kind,
      step: segmentEnd,
      controllerSequence: order,
    })),
    recording: {
      digest: digestOf(recording),
      byteLength: utf8ByteLength(recording),
    },
    checkpoint,
  };
  const result = acceptSegment(run, segment, digestOf(canonicalJson(segment)));
  if (!result.ok || events.length === 0)
    return accepted(physical, "advance", result);
  const applied = physical.applied[record.requestId] ?? {
    pickup: false,
    placement: false,
  };
  return next(
    {
      ...physical,
      applied: {
        ...physical.applied,
        [record.requestId]: {
          pickup: applied.pickup || events.includes("pickup"),
          placement: applied.placement || events.includes("placement"),
        },
      },
    },
    result.value,
  );
}

/**
 * An idle device offers a settled hold, so that it needs no evidence while
 * it waits. A device whose attempt failed holds nothing: its time passes
 * only as its own clock evidences it.
 */
function answerRest(
  physical: PhysicalRun,
  need: Variant<ExecutionNeed, "rest">,
): Answer {
  const run = physical.run;
  const cell = cellOf(run, need.cellId);
  const from = cell.committed.checkpoint.step;
  let steps = 1 as StepCount;
  let settled = true;
  if (cell.hold.kind === "unresolved") {
    const reached = stepsSince(
      cell.committed.boundary,
      frontier(physical.ledger, sourceOf(physical, cell.id)),
    );
    if (reached < 1) {
      const failure = openDisposition(physical);
      return {
        kind: "stop",
        physical,
        stop: failure ?? { kind: "engine", status: run.status.kind },
      };
    }
    steps = Math.min(reached, need.steps) as StepCount;
    settled = false;
  }
  const definition = run.definition.scenario.cells.find(
    (candidate) => candidate.id === cell.id,
  );
  const model = definition?.holdModel ?? null;
  const checkpoint = checkpointAt(cell.id, (from + steps) as StepCount, {
    rest: cell.committed.checkpoint.digest,
  });
  return accepted(
    physical,
    "rest",
    acceptRest(run, {
      cellId: cell.id,
      predecessor: need.predecessor,
      checkpoint,
      recording: {
        kind: "idle",
        cellId: cell.id,
        predecessor: need.predecessor,
        checkpoint: checkpoint.digest,
        content: "{}",
        steps: { start: from, end: checkpoint.step },
      },
      settled:
        settled && model !== null
          ? {
              model,
              support: "device-idle",
              qualified: elapsed(
                ZERO_TIME,
                run.definition.scenario.limits.horizon,
              ),
            }
          : null,
    }),
  );
}

/** A mould group entering or leaving a cobot cell is the cell's custody. */
function answerBoundary(
  physical: PhysicalRun,
  need: Variant<ExecutionNeed, "boundary">,
): Answer {
  const request = need.request;
  const slot = slotAfter(request.slot, request.operation);
  if (slot === null)
    return {
      kind: "stop",
      physical,
      stop: {
        kind: "rejected",
        need: "boundary",
        reason: "slot_forbids_boundary",
      },
    };
  const cell = cellOf(physical.run, request.cellId);
  const checkpoint = checkpointAt(cell.id, cell.committed.checkpoint.step, {
    boundary: request.boundary,
    predecessor: request.predecessor,
  });
  const content = canonicalJson(request.operation);
  const candidate: BoundaryCandidate = {
    boundary: request.boundary,
    cellId: request.cellId,
    predecessor: request.predecessor,
    checkpoint,
    slot,
    recording: {
      kind: request.operation.kind,
      cellId: request.cellId,
      predecessor: request.predecessor,
      checkpoint: checkpoint.digest,
      content,
      step: checkpoint.step,
    },
    digest: digestOf(canonicalJson({ request, checkpoint })),
  };
  return accepted(
    physical,
    "boundary",
    supplyBoundary(physical.run, candidate),
  );
}

function answer(physical: PhysicalRun): Answer {
  const status = physical.run.status;
  if (status.kind === "completed")
    return {
      kind: "stop",
      physical,
      stop: { kind: "completed", at: status.completedAt },
    };
  if (status.kind !== "awaiting-execution") {
    const failure = openDisposition(physical);
    return {
      kind: "stop",
      physical,
      stop:
        failure ??
        (status.kind === "advancing"
          ? { kind: "until", at: physical.run.position.time }
          : { kind: "engine", status: status.kind }),
    };
  }
  const need = status.need;
  switch (need.kind) {
    case "start":
      return answerStart(physical, need);
    case "advance":
      return answerAdvance(physical, need);
    case "rest":
      return answerRest(physical, need);
    case "boundary":
      return answerBoundary(physical, need);
    default:
      return need satisfies never;
  }
}

/**
 * Adds the new evidence, then advances the run as far as evidence allows,
 * up to `until`. It returns the run, each evidence item it did not apply,
 * and the one thing the run waits for.
 */
export function drivePhysicalRun(
  physical: PhysicalRun,
  evidence: readonly PhysicalEvidence[],
  until: LogicalTime,
): PhysicalStop {
  const ingested = ingestEvidence(
    physical.bake,
    physical.run.identity.executionId,
    physical.ledger,
    evidence,
  );
  let current: PhysicalRun = { ...physical, ledger: ingested.ledger };
  for (;;) {
    current = { ...current, run: advanceRun(current.run, until) };
    const result = answer(current);
    if (result.kind === "stop")
      return {
        run: result.physical,
        dispositions: ingested.dispositions,
        stop: result.stop,
      };
    current = result.physical;
  }
}
