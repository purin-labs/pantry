import { hasExactKeys, isRecord, parseJsonOrNull, sha256Hex } from "@purin-labs/std";
import {
  readCellRecordingDocument,
  type PhysicsView,
} from "../../index.ts";
import type { PersistentPourOverCell } from "@purin-labs/bakery-model/bakery-physics";

/** A pose in MuJoCo order: position, then a WXYZ quaternion. */
export type StationPose = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
type Vector3 = readonly [number, number, number];

export type PourOverDeviation =
  | Readonly<{ kind: "pour-start"; pour: number; offsetS: number }>
  | Readonly<{ kind: "pour-mass"; pour: number; errorG: number }>
  | Readonly<{ kind: "pour-duration"; pour: number; seconds: number }>
  | Readonly<{ kind: "brew-time"; seconds: number }>
  | Readonly<{ kind: "kettle-exhausted"; pour: number }>;

export type PourOverOutcome =
  | Readonly<{ kind: "completed"; beverageMg: number; reason?: never }>
  | Readonly<{ kind: "failed"; reason: string; beverageMg?: never }>;

/** One accepted solver step of the station, as the controller recorded it. */
export type PourOverSample = Readonly<{
  step: number;
  joints: readonly number[];
  fingers: readonly [number, number];
  gripper: StationPose;
  kettle: StationPose;
  dripper: StationPose;
  server: StationPose;
  scale: Readonly<{
    loadKg: number;
    readingG: number | null;
    tared: boolean;
    stable: boolean;
  }>;
  water: Readonly<{
    kettleG: number;
    kettleC: number;
    airborneG: number;
    absorbedG: number;
    freeG: number;
    bedC: number;
    serverG: number;
    serverC: number;
    spillG: number;
    evaporatedG: number;
    pouredG: number;
    offBedG: number;
    wetRadiusM: number;
    flowGS: number;
  }>;
  stream: Readonly<{
    outlet: Vector3;
    velocity: Vector3;
    landing: Vector3;
    flightS: number;
  }> | null;
  control: Readonly<{
    phase: string;
    stage: string | null;
    brewS: number | null;
    nextTargetG: number | null;
    deviations: readonly PourOverDeviation[];
  }>;
  outcome: PourOverOutcome | null;
}>;

function invalid(): never {
  throw new Error("Invalid pour-over sample.");
}
function finite(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : invalid();
}
function nullableFinite(raw: unknown): number | null {
  return raw === null ? null : finite(raw);
}
function vector3(raw: unknown): Vector3 {
  if (!Array.isArray(raw) || raw.length !== 3) invalid();
  return [finite(raw[0]), finite(raw[1]), finite(raw[2])];
}
function pose(raw: unknown): StationPose {
  if (!Array.isArray(raw) || raw.length !== 7) invalid();
  return [
    finite(raw[0]),
    finite(raw[1]),
    finite(raw[2]),
    finite(raw[3]),
    finite(raw[4]),
    finite(raw[5]),
    finite(raw[6]),
  ];
}
function pour(raw: unknown): number {
  const value = finite(raw);
  return Number.isInteger(value) && value >= 0 && value < 4 ? value : invalid();
}
function deviation(raw: unknown): PourOverDeviation {
  if (!isRecord(raw)) invalid();
  switch (raw.kind) {
    case "pour-start":
      return {
        kind: raw.kind,
        pour: pour(raw.pour),
        offsetS: finite(raw.offsetS),
      };
    case "pour-mass":
      return {
        kind: raw.kind,
        pour: pour(raw.pour),
        errorG: finite(raw.errorG),
      };
    case "pour-duration":
      return {
        kind: raw.kind,
        pour: pour(raw.pour),
        seconds: finite(raw.seconds),
      };
    case "brew-time":
      return { kind: raw.kind, seconds: finite(raw.seconds) };
    case "kettle-exhausted":
      return { kind: raw.kind, pour: pour(raw.pour) };
    default:
      return invalid();
  }
}
function outcome(raw: unknown): PourOverOutcome | null {
  if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
  const value = raw.outcome;
  if (value.kind === "failed" && typeof value.reason === "string")
    return { kind: "failed", reason: value.reason };
  if (value.kind === "completed" && isRecord(value.measurements))
    return {
      kind: "completed",
      beverageMg: finite(value.measurements.beverageMg),
    };
  return invalid();
}

const WATER = [
  "kettleG",
  "kettleC",
  "airborneG",
  "absorbedG",
  "freeG",
  "bedC",
  "serverG",
  "serverC",
  "spillG",
  "evaporatedG",
  "pouredG",
  "offBedG",
  "wetRadiusM",
  "flowGS",
] as const;

/** Parses one recorded sample once, before the display reads it. */
export function parsePourOverSample(raw: unknown): PourOverSample {
  if (!isRecord(raw)) invalid();
  const { scale, water, stream, control } = raw;
  if (
    !isRecord(scale) ||
    !isRecord(water) ||
    !hasExactKeys(water, WATER) ||
    !isRecord(control) ||
    typeof control.phase !== "string" ||
    !Array.isArray(control.deviations) ||
    !Array.isArray(raw.joints) ||
    raw.joints.length !== 6 ||
    !Array.isArray(raw.fingers) ||
    raw.fingers.length !== 2 ||
    typeof scale.tared !== "boolean" ||
    typeof scale.stable !== "boolean"
  )
    invalid();
  let streamValue: PourOverSample["stream"] = null;
  if (stream !== null) {
    if (!isRecord(stream)) invalid();
    streamValue = {
      outlet: vector3(stream.outlet),
      velocity: vector3(stream.velocity),
      landing: vector3(stream.landing),
      flightS: finite(stream.flightS),
    };
  }
  return {
    step: finite(raw.step),
    joints: raw.joints.map(finite),
    fingers: [finite(raw.fingers[0]), finite(raw.fingers[1])],
    gripper: pose(raw.gripper),
    kettle: pose(raw.kettle),
    dripper: pose(raw.dripper),
    server: pose(raw.server),
    scale: {
      loadKg: finite(scale.loadKg),
      readingG: nullableFinite(scale.readingG),
      tared: scale.tared,
      stable: scale.stable,
    },
    water: {
      kettleG: finite(water.kettleG),
      kettleC: finite(water.kettleC),
      airborneG: finite(water.airborneG),
      absorbedG: finite(water.absorbedG),
      freeG: finite(water.freeG),
      bedC: finite(water.bedC),
      serverG: finite(water.serverG),
      serverC: finite(water.serverC),
      spillG: finite(water.spillG),
      evaporatedG: finite(water.evaporatedG),
      pouredG: finite(water.pouredG),
      offBedG: finite(water.offBedG),
      wetRadiusM: finite(water.wetRadiusM),
      flowGS: finite(water.flowGS),
    },
    stream: streamValue,
    control: {
      phase: control.phase,
      stage: typeof control.stage === "string" ? control.stage : null,
      brewS: nullableFinite(control.brewS),
      nextTargetG: nullableFinite(control.nextTargetG),
      deviations: control.deviations.map(deviation),
    },
    outcome: outcome(raw.report),
  };
}

/** The station's current state from the worker, before any recording. */
export function readPourOverObservation(
  raw: unknown,
  cell: PersistentPourOverCell,
): PourOverSample {
  if (
    !isRecord(raw) ||
    raw.kind !== "observed" ||
    raw.modelHash !== cell.modelHash
  )
    throw new Error("The pour-over observation differs from its model.");
  return parsePourOverSample(raw.sample);
}

/** Every accepted 20 ms sample of a recording the engine retained. */
export async function readPourOverSamples(
  view: Exclude<PhysicsView, { kind: "unavailable" }>,
  cell: PersistentPourOverCell,
): Promise<readonly PourOverSample[]> {
  if (
    view.cell !== cell.cellId ||
    (await sha256Hex(view.content)) !== view.digest
  )
    throw new Error(
      "The pour-over recording differs from its accepted digest.",
    );
  let raw: unknown = parseJsonOrNull(view.content);
  if (view.kind === "cell-recorded")
    raw = parseJsonOrNull(readCellRecordingDocument(raw).native);
  if (
    !isRecord(raw) ||
    raw.kind !== "pour-over-physics-recording" ||
    raw.modelHash !== cell.modelHash ||
    raw.runId !== cell.runId ||
    raw.runnerSha256 !== cell.execution.controllerHash ||
    raw.runtimeSha256 !== cell.execution.runtimeHash
  )
    throw new Error("Invalid pour-over recording.");
  const samples = isRecord(raw.motion) ? raw.motion.samples : raw.samples;
  if (!Array.isArray(samples) || samples.length === 0)
    throw new Error("Missing pour-over samples.");
  return samples.map(parsePourOverSample);
}

/** The latest accepted sample of a recording the engine retained. */
export async function readPourOverFrame(
  view: Exclude<PhysicsView, { kind: "unavailable" }>,
  cell: PersistentPourOverCell,
): Promise<PourOverSample> {
  const samples = await readPourOverSamples(view, cell);
  const last = samples.at(-1);
  if (last === undefined) throw new Error("Missing pour-over samples.");
  return last;
}
