import type { Variant } from "@purin-labs/type-utils";
import type { TaskId } from "../identity.ts";
import type { RunState } from "../state.ts";
import type { BakeStep, BakeStepKind } from "./compile.ts";
import {
  isFailedTask,
  openDisposition,
  type PhysicalRun,
  type PhysicalWait,
} from "./drive.ts";
import {
  dispatchOfTask,
  terminalReport,
  type DispatchRecord,
} from "./evidence.ts";
import type { CarrierAt, CobotPlace, CobotTask } from "./protocol.ts";

/**
 * The one read of a physical run. The workflow canvas, the timeline and the
 * 3D kitchen show this and nothing else, so they agree on each task. Every
 * observed value comes from an accepted receipt; a position that no receipt
 * proves stays `unknown`.
 */

type ObservedTaskState =
  /** Not yet wanted by the engine. */
  | "planned"
  /** The engine wants it sent; no dispatch record exists. */
  | "ready"
  /** Its dispatch record exists; no receipt yet. */
  | "dispatched"
  | "accepted"
  | "running"
  | "completed"
  | "rejected"
  | "failed";

type BakeTaskView = Readonly<{
  key: string;
  kind: BakeStepKind;
  mouldGroup: number | null;
  sourceKey: string;
  task: CobotTask;
  requestId: string | null;
  state: ObservedTaskState;
  planned: Readonly<{ startSeconds: number; endSeconds: number }>;
  observed: Readonly<{
    startSeconds: number | null;
    endSeconds: number | null;
    /** The controller's own measure of the task, from its completion. */
    observedSeconds: number | null;
  }>;
  phase: string | null;
  progress: number | null;
  carrierAt: CarrierAt | null;
  reason: string | null;
}>;

type MouldGroupPosition =
  | Readonly<{ kind: "place"; place: CobotPlace; sourceKey?: never }>
  | Readonly<{ kind: "tool"; sourceKey: string; place?: never }>
  | Readonly<{ kind: "unknown"; place?: never; sourceKey?: never }>;

type MouldGroupView = Readonly<{
  mouldGroup: number;
  position: MouldGroupPosition;
  /** `declared` before any receipt about the group, then `receipt`. */
  basis: "declared" | "receipt";
}>;

export type BakeRunView = Readonly<{
  runId: string;
  status: RunState["status"]["kind"];
  logicalSeconds: number;
  tasks: readonly BakeTaskView[];
  groups: readonly MouldGroupView[];
  /** The failed attempt a person must settle, or null. */
  disposition: Variant<PhysicalWait, "disposition"> | null;
}>;

function secondsOf(microseconds: number): number {
  return microseconds / 1_000_000;
}

function deviceSeconds(
  physical: PhysicalRun,
  sourceKey: string,
  clockMs: number,
): number {
  return (clockMs - (physical.ledger.origin[sourceKey] ?? 0)) / 1_000;
}

function recordOf(physical: PhysicalRun, task: TaskId): DispatchRecord | null {
  return dispatchOfTask(physical.ledger, task);
}

function engineState(run: RunState, task: TaskId) {
  for (const state of run.tasks) if (state.id === task) return state;
  return null;
}

function stateOf(
  physical: PhysicalRun,
  step: BakeStep,
  record: DispatchRecord | null,
): ObservedTaskState {
  const task = engineState(physical.run, step.engineTask);
  if (task?.kind === "completed") return "completed";
  if (task !== null && isFailedTask(task))
    return record !== null && terminalReport(record)?.state === "rejected"
      ? "rejected"
      : "failed";
  if (record === null) return task?.kind === "executing" ? "ready" : "planned";
  const last = record.reports.at(-1);
  if (last === undefined) return "dispatched";
  return last.state === "accepted" ? "accepted" : "running";
}

function taskView(physical: PhysicalRun, step: BakeStep): BakeTaskView {
  const record = recordOf(physical, step.engineTask);
  const planned = physical.bake.plan.steps.find(
    (candidate) => candidate.key === step.key,
  );
  const reports = record?.reports ?? [];
  const first = reports[0];
  const last = reports.at(-1);
  const end = record === null ? null : terminalReport(record);
  const endClock = end?.deviceClockMs ?? record?.lost?.clockMs ?? null;
  return {
    key: step.key,
    kind: step.kind,
    mouldGroup: step.mouldGroup,
    sourceKey: step.sourceKey,
    task: step.task,
    requestId: record?.requestId ?? null,
    state: stateOf(physical, step, record),
    planned: {
      startSeconds: secondsOf(planned?.start ?? 0),
      endSeconds: secondsOf(planned?.end ?? 0),
    },
    observed: {
      startSeconds:
        first === undefined
          ? null
          : deviceSeconds(physical, step.sourceKey, first.deviceClockMs),
      endSeconds:
        endClock === null
          ? null
          : deviceSeconds(physical, step.sourceKey, endClock),
      observedSeconds: end?.observedSeconds ?? null,
    },
    phase: last?.phase ?? null,
    progress: last?.progress ?? null,
    carrierAt: last?.carrierAt ?? null,
    reason:
      end?.reason ??
      (record !== null && record.lost !== null ? "report_lost" : null),
  };
}

function positionAt(
  step: BakeStep,
  carrierAt: CarrierAt,
  current: MouldGroupPosition,
): MouldGroupPosition {
  if (step.task.kind !== "move_mould_group") return current;
  switch (carrierAt) {
    case "source":
      return { kind: "place", place: step.task.from };
    case "tool":
      return { kind: "tool", sourceKey: step.sourceKey };
    case "destination":
      return { kind: "place", place: step.task.to };
    case "unknown":
      return { kind: "unknown" };
    default:
      return carrierAt satisfies never;
  }
}

/**
 * The last evidenced position of a mould group. Its moves apply in order;
 * once a receipt leaves the position unknown, no later value replaces it,
 * because no later move of that group can start.
 */
function groupView(
  physical: PhysicalRun,
  mouldGroup: number,
  place: CobotPlace,
): MouldGroupView {
  let position: MouldGroupPosition = { kind: "place", place };
  let basis: MouldGroupView["basis"] = "declared";
  for (const step of physical.bake.steps) {
    if (step.mouldGroup !== mouldGroup) continue;
    const record = recordOf(physical, step.engineTask);
    if (record === null) continue;
    const task = engineState(physical.run, step.engineTask);
    if (task?.kind === "completed") {
      position = positionAt(step, "destination", position);
      basis = "receipt";
      continue;
    }
    if (task !== null && isFailedTask(task)) {
      position = positionAt(step, task.disposition, position);
      basis = "receipt";
      continue;
    }
    for (const report of record.reports)
      if (report.carrierAt !== null && position.kind !== "unknown") {
        position = positionAt(step, report.carrierAt, position);
        basis = "receipt";
      }
  }
  return { mouldGroup, position, basis };
}

export function observeBakeRun(physical: PhysicalRun): BakeRunView {
  const disposition = openDisposition(physical);
  return {
    runId: physical.bake.runId,
    status: physical.run.status.kind,
    logicalSeconds: secondsOf(physical.run.position.time),
    tasks: physical.bake.steps.map((step) => taskView(physical, step)),
    groups: physical.bake.initial.map(({ mouldGroup, place }) =>
      groupView(physical, mouldGroup, place),
    ),
    disposition: disposition?.kind === "disposition" ? disposition : null,
  };
}
