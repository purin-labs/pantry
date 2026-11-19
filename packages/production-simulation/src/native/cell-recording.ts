import { readOperationContacts } from "../physics-contacts.ts";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type { Sha256Hex } from "../identity.ts";
import type { CarrierSlot, CellRecording, CheckpointRef } from "../physics.ts";
import { stepCount, type StepCount } from "../time.ts";
import type { NativeCell } from "./cell-adapter.ts";

type ExpectedMotion =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "admission" | "removal";
      before: CarrierSlot;
      after: CarrierSlot;
      nativeCarrier: string;
    }>;

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function readStep(raw: unknown): StepCount {
  const parsed = typeof raw === "number" ? stepCount(raw) : null;
  if (parsed === null || !parsed.ok)
    throw new TypeError("A cell recording has an invalid step");
  return parsed.value;
}

function requireVector(raw: unknown, length: number): void {
  requireValue(
    Array.isArray(raw) && raw.length === length,
    "Invalid pose vector",
  );
  for (const value of raw)
    requireValue(
      typeof value === "number" && Number.isFinite(value),
      "Invalid pose value",
    );
}

function requireSample(
  raw: unknown,
  step: StepCount,
  fixture: NativeCell["fixture"],
): asserts raw is Record<string, unknown> {
  requireValue(
    isRecord(raw) && raw.step === step,
    "A recording is missing an exact boundary sample",
  );
  // The station contract (station-replies.ts) checked each station sample
  // when its reply arrived.
  if (
    fixture === "persistent-espresso/1" ||
    fixture === "persistent-pour-over/1"
  )
    return;
  requireVector(raw.joints, 6);
  requireVector(raw.tray, 7);
  requireVector(raw.tool, 7);
  requireVector(raw.jaw, 7);
}

/** Validate dense evidence before accepting the current native runtime's reply. */
export function requireDenseOperationRecording(
  raw: Record<string, unknown>,
  fixture: NativeCell["fixture"],
): void {
  const start = readStep(raw.startStep);
  const end = readStep(raw.endStep);
  requireValue(
    end >= start && end - start <= 32,
    "An operation recording exceeds 32 steps",
  );
  requireValue(
    Array.isArray(raw.samples) && raw.samples.length === end - start + 1,
    "An operation requires every solver pose",
  );
  for (let index = 0; index < raw.samples.length; index++)
    requireSample(raw.samples[index], readStep(start + index), fixture);
  if (fixture === "persistent-espresso/1") return;
  const contacts = readOperationContacts(raw.contacts, start, end);
  requireValue(
    contacts.kind === "dense",
    "An operation requires contact evidence for every executed step",
  );
}

function requireSlot(
  raw: unknown,
  expected: CarrierSlot,
  nativeCarrier: string,
): void {
  requireValue(
    isRecord(raw) &&
      isNonNegativeInteger(raw.generation) &&
      raw.kind === expected.kind &&
      raw.generation === expected.generation,
    "A handoff recording has another slot",
  );
  if (expected.kind === "active")
    requireValue(
      raw.carrier === nativeCarrier,
      "A handoff recording names another carrier",
    );
  else
    requireValue(raw.carrier === undefined, "An inactive slot has no carrier");
}

function recordingKind(fixture: NativeCell["fixture"]): string {
  switch (fixture) {
    case "persistent-espresso/1":
      return "espresso-physics-recording";
    case "persistent-pour-over/1":
      return "pour-over-physics-recording";
    default:
      return "cell-physics-recording";
  }
}

/** Parse a native reply once, before its observations enter the engine. */
export function readCellRecording(
  raw: unknown,
  cell: NativeCell,
  predecessor: Sha256Hex,
  checkpoint: CheckpointRef,
  expected: ExpectedMotion,
): CellRecording {
  requireValue(
    isRecord(raw) &&
      raw.kind === recordingKind(cell.fixture) &&
      raw.schemaVersion === 1 &&
      raw.cellId === cell.cellId &&
      raw.runId === cell.runId &&
      raw.modelHash === cell.modelHash &&
      raw.runnerSha256 === cell.controllerHash &&
      raw.runtimeSha256 === cell.runtimeHash &&
      raw.predecessor === predecessor &&
      raw.checkpoint === checkpoint.digest,
    "A cell recording differs from its world or checkpoint",
  );
  if (cell.fixture === "persistent-espresso/1") {
    requireValue(
      expected.kind === "idle",
      "Espresso fixtures have no carrier boundary",
    );
    const start = readStep(raw.startStep);
    const end = readStep(raw.endStep);
    requireValue(
      end > start &&
        end - start <= 32 &&
        Array.isArray(raw.samples) &&
        raw.samples.length === 2,
      "Espresso idle recording requires two bounded endpoints",
    );
    requireSample(raw.samples[0], start, cell.fixture);
    requireSample(raw.samples[1], end, cell.fixture);
    requireValue(
      end === checkpoint.step && end > start,
      "Espresso idle interval differs",
    );
    return {
      kind: "idle",
      cellId: cell.cellId,
      predecessor,
      checkpoint: checkpoint.digest,
      steps: { start, end },
      content: JSON.stringify(raw),
    };
  }
  const motion = raw.motion;
  requireValue(
    isRecord(motion) && motion.kind === expected.kind,
    "Unexpected cell recording motion",
  );
  requireValue(
    cell.fixture !== "persistent-pour-over/1" || expected.kind === "idle",
    "The pour-over station has no carrier boundary",
  );
  const content = JSON.stringify(raw);
  if (expected.kind === "idle") {
    const start = readStep(motion.startStep);
    const end = readStep(motion.endStep);
    requireValue(
      end === checkpoint.step && end > start && end - start <= 32,
      "An idle recording exceeds its bounded interval",
    );
    requireValue(
      motion.sampleStride === 1 && Array.isArray(motion.samples),
      "An idle recording declares its sample cadence",
    );
    const sampleSteps = [start];
    for (let step = start + 1; step < end; step += 1)
      sampleSteps.push(readStep(step));
    sampleSteps.push(end);
    requireValue(
      motion.samples.length === sampleSteps.length,
      "An idle recording must include its cadence and interval endpoints",
    );
    for (const [index, step] of sampleSteps.entries()) {
      requireSample(motion.samples[index], step, cell.fixture);
    }
    requireValue(
      readOperationContacts(motion.contacts, start, end).kind === "dense",
      "An idle recording requires contacts for every executed step",
    );
    return {
      kind: "idle",
      cellId: cell.cellId,
      predecessor,
      checkpoint: checkpoint.digest,
      steps: { start, end },
      content,
    };
  }
  const step = readStep(motion.step);
  requireValue(step === checkpoint.step, "A handoff takes no solver step");
  requireSample(motion.before, step, cell.fixture);
  requireSample(motion.after, step, cell.fixture);
  requireSlot(motion.beforeSlot, expected.before, expected.nativeCarrier);
  requireSlot(motion.afterSlot, expected.after, expected.nativeCarrier);
  for (const key of ["joints", "tool", "jaw"])
    requireValue(
      JSON.stringify(motion.before[key]) === JSON.stringify(motion.after[key]),
      "A carrier handoff changed the arm",
    );
  return {
    kind: expected.kind,
    cellId: cell.cellId,
    predecessor,
    checkpoint: checkpoint.digest,
    step,
    content,
  };
}
