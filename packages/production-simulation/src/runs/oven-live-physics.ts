import {
  readOperationContacts,
  type OperationContacts,
} from "../index.ts";
import {
  parseSha256Hex,
  readCellRecordingDocument,
  type PhysicsView,
  type RunState,
} from "../index.ts";
import type { VariantBy } from "@seams/type-utils";
import {
  isRecord,
  isNonNegativeInteger,
  parseJsonOrNull,
  sha256Hex,
  assertNever,
} from "@seams/std";
import { nativeIdentity } from "../native/cell-adapter.ts";
import {
  parsePersistentPhysicsScene,
  parsePersistentPhysicsMotion,
  type PersistentCell,
  type PersistentPhysicsScene,
  type PersistentPhysicsMotion,
  type PhysicsSample,
} from "@seams/bakery-model/bakery-physics";
import type { StrictUnion } from "@seams/type-utils";

type Frame = Readonly<{ cell: string; committedAt: number; at: number }>;
export type OvenSlot = StrictUnion<
  | Readonly<{ kind: "inactive"; generation: number }>
  | Readonly<{ kind: "active"; generation: number; carrier: string }>
>;
export type OvenLiveFrame = Frame &
  StrictUnion<
    | Readonly<{
        purpose: "operation" | "recovery";
        contacts: OperationContacts;
        task: string;
        startedAt: number;
        motion: PersistentPhysicsMotion;
      }>
    | Readonly<{
        purpose: "idle";
        contacts: OperationContacts;
        after: number;
        motion: PersistentPhysicsMotion;
      }>
    | Readonly<{
        purpose: "admission" | "removal";
        boundary: string;
        before: Readonly<{ motion: PersistentPhysicsMotion; slot: OvenSlot }>;
        after: Readonly<{ motion: PersistentPhysicsMotion; slot: OvenSlot }>;
      }>
  >;

export function ovenFrameMotion(
  frame: OvenLiveFrame,
  endpoint: "before" | "after",
): PersistentPhysicsMotion {
  switch (frame.purpose) {
    case "admission":
    case "removal":
      return frame[endpoint].motion;
    case "operation":
    case "recovery":
    case "idle":
      return frame.motion;
    default:
      return assertNever(frame);
  }
}

export function ovenSampleTime(
  frame: OvenLiveFrame,
  sample: PhysicsSample,
): number {
  switch (frame.purpose) {
    case "operation":
    case "recovery":
      return frame.startedAt + sample.step * 2000;
    case "idle":
      return frame.after + (sample.step - frame.motion.samples[0].step) * 2000;
    case "admission":
    case "removal":
      return frame.at;
    default:
      return assertNever(frame);
  }
}

export function ovenFrameLabel(frame: OvenLiveFrame): string {
  switch (frame.purpose) {
    case "operation":
    case "recovery":
      return frame.task;
    case "idle":
      return "Idle cell";
    case "admission":
      return "Carrier admission";
    case "removal":
      return "Carrier removal";
    default:
      return assertNever(frame);
  }
}

export function readOvenScene(
  cell: PersistentCell,
  raw: unknown,
): PersistentPhysicsScene {
  if (
    !isRecord(raw) ||
    raw.kind !== "scene" ||
    raw.version !== 1 ||
    raw.cell !== cell.cellId ||
    raw.modelHash !== cell.modelHash
  )
    throw new Error(
      "This retained build does not provide the matching live scene.",
    );
  return parsePersistentPhysicsScene(cell, raw.setup, raw.robotGlbSha256);
}

function requireOvenSkill(skill: string): void {
  switch (skill) {
    case "oven-loading":
    case "oven-retrieval":
    case "rack-transfer":
      return;
    default:
      throw new Error("This operation has no supported oven scene.");
  }
}

export function ovenOperation(
  run: RunState,
  taskId: string,
): Readonly<{
  cell: string;
  skill: string;
}> {
  for (const task of run.tasks) {
    if (task.id !== taskId || task.subject.kind !== "workflow") continue;
    for (const instance of run.instances) {
      if (instance.id !== task.subject.instance) continue;
      for (const workflow of run.definition.scenario.workflows) {
        if (workflow.id !== instance.workflow) continue;
        for (const definition of workflow.tasks) {
          if (
            definition.key !== task.subject.key ||
            definition.executor.kind !== "native"
          )
            continue;
          const operation = definition.executor.operation;
          requireOvenSkill(operation.skill);
          return { cell: operation.cell, skill: operation.skill };
        }
      }
    }
  }
  throw new Error("Select a physical loading, retrieval, or racking task.");
}

/** Checks a disposable observation independently of the durable pack reader. */
export async function readOvenLiveFrame(
  scene: PersistentPhysicsScene,
  view: Exclude<PhysicsView, { kind: "unavailable" }>,
  committedAt: number,
): Promise<OvenLiveFrame> {
  if (view.kind === "cell-recorded")
    return readOvenCellFrame(scene, view, committedAt);
  const cell = scene.cell;
  const raw = parseJsonOrNull(view.content);
  if (
    !isRecord(raw) ||
    (await sha256Hex(view.content)) !== view.digest ||
    view.cell !== cell.cellId ||
    raw.runId !== cell.runId ||
    raw.attemptId !== nativeIdentity(view.attempt) ||
    raw.schemaVersion !== 1 ||
    raw.modelHash !== cell.modelHash ||
    raw.runnerSha256 !== cell.execution.controllerHash ||
    raw.runtimeSha256 !== cell.execution.runtimeHash ||
    !isNonNegativeInteger(raw.sequence) ||
    !isNonNegativeInteger(raw.startStep) ||
    !isNonNegativeInteger(raw.endStep) ||
    raw.endStep <= raw.startStep ||
    raw.endStep - raw.startStep > 32 ||
    !parseSha256Hex(raw.checkpoint).ok ||
    !parseSha256Hex(raw.predecessor).ok ||
    !Array.isArray(raw.samples) ||
    view.at !== view.startedAt + raw.endStep * 2000 ||
    view.at > committedAt
  )
    throw new Error("The live recording does not match its accepted boundary.");
  requireOvenSkill(view.skill);
  const motion = parsePersistentPhysicsMotion(scene, raw.samples);
  if (
    motion.samples[0].step !== raw.startStep ||
    motion.endStep !== raw.endStep
  )
    throw new Error("The live recording is missing a boundary sample.");
  return {
    task: view.task,
    cell: view.cell,
    startedAt: view.startedAt,
    committedAt,
    motion,
    purpose: view.purpose,
    contacts: readOperationContacts(
      raw.contacts ?? { kind: "not-recorded" },
      raw.startStep,
      raw.endStep,
    ),
    at: view.at,
  };
}

function readSlot(raw: unknown): OvenSlot {
  if (!isRecord(raw) || !isNonNegativeInteger(raw.generation))
    throw new Error("Invalid carrier slot.");
  if (raw.kind === "inactive" && raw.carrier === undefined)
    return { kind: "inactive", generation: raw.generation };
  if (
    raw.kind === "active" &&
    typeof raw.carrier === "string" &&
    raw.carrier.length > 0 &&
    (raw.location === "source" ||
      raw.location === "oven" ||
      raw.location === "returned" ||
      raw.location === "rack")
  )
    return { kind: "active", generation: raw.generation, carrier: raw.carrier };
  throw new Error("Invalid carrier slot.");
}

async function readOvenCellFrame(
  scene: PersistentPhysicsScene,
  view: VariantBy<PhysicsView, "kind", "cell-recorded">,
  committedAt: number,
): Promise<OvenLiveFrame> {
  const document = readCellRecordingDocument(parseJsonOrNull(view.content));
  const raw = parseJsonOrNull(document.native);
  const cell = scene.cell;
  if (
    (await sha256Hex(view.content)) !== view.digest ||
    view.cell !== cell.cellId ||
    document.cellId !== cell.cellId ||
    !isRecord(raw) ||
    raw.kind !== "cell-physics-recording" ||
    raw.schemaVersion !== 1 ||
    raw.cellId !== cell.cellId ||
    raw.runId !== cell.runId ||
    raw.modelHash !== cell.modelHash ||
    raw.runnerSha256 !== cell.execution.controllerHash ||
    raw.runtimeSha256 !== cell.execution.runtimeHash ||
    !parseSha256Hex(raw.predecessor).ok ||
    !parseSha256Hex(raw.checkpoint).ok ||
    !isRecord(raw.motion) ||
    raw.motion.kind !== document.time.kind ||
    view.at > committedAt
  )
    throw new Error("The cell recording does not match its retained world.");
  const motion = raw.motion;
  const time = document.time;
  if (time.kind === "idle") {
    if (
      !isNonNegativeInteger(motion.startStep) ||
      !isNonNegativeInteger(motion.endStep) ||
      motion.endStep <= motion.startStep ||
      motion.endStep - motion.startStep > 32 ||
      (motion.sampleStride !== 1 && motion.sampleStride !== 8) ||
      !Array.isArray(motion.samples) ||
      time.through - time.after !==
        (motion.endStep - motion.startStep) * 2000 ||
      view.at !== time.through
    )
      throw new Error("Invalid idle recording clock or cadence.");
    const parsed = parsePersistentPhysicsMotion(scene, motion.samples);
    const steps = [motion.startStep];
    for (
      let step =
        motion.startStep +
        motion.sampleStride -
        (motion.startStep % motion.sampleStride);
      step < motion.endStep;
      step += motion.sampleStride
    )
      steps.push(step);
    steps.push(motion.endStep);
    if (parsed.samples.length !== steps.length)
      throw new Error("Idle recording samples are missing.");
    for (const [index, sample] of parsed.samples.entries())
      if (sample.step !== steps[index])
        throw new Error("Idle recording samples have another cadence.");
    return {
      purpose: "idle",
      cell: view.cell,
      at: view.at,
      committedAt,
      after: time.after,
      motion: parsed,
      contacts: readOperationContacts(
        motion.contacts ?? { kind: "not-recorded" },
        motion.startStep,
        motion.endStep,
      ),
    };
  }
  if (!isNonNegativeInteger(motion.step) || view.at !== time.at)
    throw new Error("Invalid handoff clock.");
  // Endpoints stay separate. A renderer must never interpolate across a handoff.
  const before = parsePersistentPhysicsMotion(scene, [motion.before]);
  const after = parsePersistentPhysicsMotion(scene, [motion.after]);
  if (before.endStep !== motion.step || after.endStep !== motion.step)
    throw new Error("A handoff consumes no solver step.");
  for (const key of ["joints", "tool", "jaw"] as const)
    if (
      JSON.stringify(before.samples[0][key]) !==
      JSON.stringify(after.samples[0][key])
    )
      throw new Error("A handoff changed the arm.");
  const beforeSlot = readSlot(motion.beforeSlot);
  const afterSlot = readSlot(motion.afterSlot);
  if (time.kind === "admission") {
    if (
      beforeSlot.kind !== "inactive" ||
      afterSlot.kind !== "active" ||
      afterSlot.generation !== beforeSlot.generation + 1
    )
      throw new Error("Invalid admission slots.");
  } else if (
    beforeSlot.kind !== "active" ||
    afterSlot.kind !== "inactive" ||
    afterSlot.generation !== beforeSlot.generation
  )
    throw new Error("Invalid removal slots.");
  return {
    purpose: time.kind,
    cell: view.cell,
    at: view.at,
    committedAt,
    boundary: time.boundary,
    before: { motion: before, slot: beforeSlot },
    after: { motion: after, slot: afterSlot },
  };
}

export function withOvenCommittedAt(
  frame: OvenLiveFrame,
  committedAt: number,
): OvenLiveFrame {
  switch (frame.purpose) {
    case "operation":
    case "recovery":
      return {
        purpose: frame.purpose,
        cell: frame.cell,
        at: frame.at,
        committedAt,
        task: frame.task,
        contacts: frame.contacts,
        startedAt: frame.startedAt,
        motion: frame.motion,
      };
    case "idle":
      return {
        purpose: "idle",
        cell: frame.cell,
        at: frame.at,
        committedAt,
        after: frame.after,
        motion: frame.motion,
        contacts: frame.contacts,
      };
    case "admission":
    case "removal":
      return {
        purpose: frame.purpose,
        cell: frame.cell,
        at: frame.at,
        committedAt,
        boundary: frame.boundary,
        before: frame.before,
        after: frame.after,
      };
    default:
      return assertNever(frame);
  }
}
