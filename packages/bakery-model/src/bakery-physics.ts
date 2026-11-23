import { ROBOTS, parseRobotModel, type RobotModel } from "./bakery-robots.ts";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever, sha256Hex } from "@purin-labs/std";
import {
  parseOperationMargins,
  type OperationMargins,
} from "./bakery-margins.ts";

const validated: unique symbol = Symbol("validated physics recording");
const validatedRequest: unique symbol = Symbol("validated physics request");
const validatedCell: unique symbol = Symbol("validated persistent cell");
const validatedRackSequence: unique symbol = Symbol("validated rack sequence");
const validatedSequence: unique symbol = Symbol("validated physics sequence");
const validatedCyclePlan: unique symbol = Symbol(
  "validated physics cycle plan",
);
const validatedPersistentMotion: unique symbol = Symbol(
  "persistent physics motion",
);
const validatedPersistentScene: unique symbol = Symbol(
  "persistent physics scene",
);
export const LINEA_GLB_SHA256 =
  "142fac26dd1feca6c21395415d0453e9f2c88e7a2c0a05ec35073365b11456f3";
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 4096;
export const MARUZEN_GLB_SHA256 =
  "a933f3458b83e61242b27727ac3f54a1b40799468ba17488d80881e3cbdb2599";
/**
 * Earlier exports of the Maruzen visual that recordings may name. A recording
 * keeps the identity that produced it. The export of 2026-10-16 only removed
 * zero-area triangles: no transform, hinge or collision changed, so a
 * recording made with the earlier export replays on the current one. Never
 * add an export whose geometry moved.
 */
const EARLIER_MARUZEN_GLB_SHA256: ReadonlySet<string> = new Set([
  "835cdad18287a279f5f7dd67676e2d1dffeada75e655b2cdec73bff07bf10b4f",
]);

export type Vector3 = readonly [number, number, number];
/** Metres, Z-up; quaternion WXYZ. */
export type PhysicsPose = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export type JointAngles = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
export type PhysicsBody = "world" | "tool" | "jaw" | "tray";
export type PhysicsGeometry = Readonly<{
  name: string;
  body: PhysicsBody;
  shape: "box" | "cylinder" | "capsule";
  size: Vector3;
  pose: PhysicsPose;
  rgba: readonly [number, number, number, number];
}>;
export type PhysicsSample = Readonly<{
  step: number;
  joints: JointAngles;
  tool: PhysicsPose;
  jaw: PhysicsPose;
  tray: PhysicsPose;
}>;
export type PhysicsEvent = Readonly<{
  step: number;
  kind: "phase" | "pickup" | "placement" | "failure";
  label: string;
}>;
export type PhysicsOutcome =
  | Readonly<{
      kind: "completed";
      step: number;
      evidence: Readonly<{
        positionErrorM: number;
        orientationErrorRad: number;
        linearSpeedMps: number;
        angularSpeedRadps: number;
        settledSeconds: number;
      }>;
      /** Absent from an engine before Refactor 16 step 7: "not measured". */
      margins?: OperationMargins;
      reason?: never;
      message?: never;
      trayDisposition?: never;
    }>
  | Readonly<{
      kind: "failed";
      step: number;
      reason: string;
      trayDisposition: "source" | "gripped" | "destination" | "unknown";
      /** Absent before the first step, or from an older engine. */
      margins?: OperationMargins;
      evidence?: never;
      message?: never;
    }>
  | Readonly<{
      kind: "execution-error";
      step: number;
      message: string;
      evidence?: never;
      reason?: never;
      trayDisposition?: never;
      margins?: never;
    }>;
export type PhysicsExecutionIdentity =
  | Readonly<{
      controller: "bakery-native";
      backend: "native" | "browser";
      controllerSourceHash: string;
      controllerHash: string;
      runtimeHash: string;
    }>
  | Readonly<{
      controller: "bakery-native";
      backend: "unknown";
      controllerSourceHash: null;
      controllerHash: string;
      runtimeHash: string;
    }>
  | Readonly<{
      controller: "python-reference";
      backend: "unknown";
      controllerSourceHash: null;
      controllerHash?: never;
      runtimeHash?: never;
    }>;
export type PhysicsLayout =
  | Readonly<{ kind: "fixed"; xMm?: never; yMm?: never }>
  | Readonly<{ kind: "rack-translation"; xMm: number; yMm: number }>;

export const PHYSICS_ASSETS_SHA256 =
  "ab67e21d7e659c18cc038aa38d9c88d2e24fe74e2cc8a274f1cdfb0c721f499d";

export function parsePhysicsLayout(value: unknown): PhysicsLayout {
  const raw = object(value);
  if (raw.kind === "fixed") {
    keys(raw, ["kind"]);
    return { kind: "fixed" };
  }
  keys(raw, ["kind", "xMm", "yMm"]);
  if (
    raw.kind !== "rack-translation" ||
    !Number.isInteger(raw.xMm) ||
    !Number.isInteger(raw.yMm)
  )
    throw new Error("Rack offsets must be whole millimetres.");
  const xMm = number(raw.xMm, -600, 600);
  const yMm = number(raw.yMm, -600, 600);
  if (xMm === 0 && yMm === 0) return { kind: "fixed" };
  return { kind: "rack-translation", xMm, yMm };
}

// The model identity of a request is the one TypeScript copy of the rule in
// Assets::model_hash, Assets::layout_hash and Assets::cell of
// crates/bakery-native/src/assets.rs. A change to the rule changes both
// copies; the Rust file is part of the engine identity, so it also needs an
// engine release. The Portal, the engine worker and the appliance registry
// check use these functions. Two checks prove that the copies agree: the
// registry check reads the example recordings that bakery-native wrote, and
// the robot selection journey compares native and browser requests.

/** The fixture cells of the engine, named as Cell::stem names them. */
export const PHYSICS_CELLS = [
  "separate",
  "combined",
  "combined-blocked-rack",
  "combined-unreachable-rack",
  "pan-staging",
] as const;

export type PhysicsCell = (typeof PHYSICS_CELLS)[number];

/**
 * The model hash of a fixture cell. `assetsSha256` is the SHA-256 of the
 * asset list; the engine worker gives the hash of the list that its bundle
 * holds.
 */
export async function workcellModelHash(
  robot: RobotModel,
  cell: PhysicsCell,
  assetsSha256: string = PHYSICS_ASSETS_SHA256,
): Promise<string> {
  return sha256Hex(`robot-v1:${robot}:${cell}:${assetsSha256}`);
}

/** The model hash of the separate cell with its rack at `layout`. */
export async function rackLayoutHash(
  layout: PhysicsLayout,
  robot: RobotModel,
  assetsSha256: string = PHYSICS_ASSETS_SHA256,
): Promise<string> {
  const base = await workcellModelHash(robot, "separate", assetsSha256);
  if (layout.kind === "fixed") return base;
  return sha256Hex(
    `rack-layout-v1:mujoco-4.0.0:${base}:${layout.xMm}:${layout.yMm}`,
  );
}

/**
 * The fixture cell of the model that a request names, or null when the
 * request names no model of these assets. Only the separate cell can move
 * its rack.
 */
export async function physicsCellOf(
  request: Readonly<{
    robot: RobotModel;
    modelHash: string;
    layout: PhysicsLayout;
  }>,
  assetsSha256: string = PHYSICS_ASSETS_SHA256,
): Promise<PhysicsCell | null> {
  const { robot, modelHash, layout } = request;
  if (layout.kind !== "fixed")
    return modelHash === (await rackLayoutHash(layout, robot, assetsSha256))
      ? "separate"
      : null;
  for (const cell of PHYSICS_CELLS)
    if (modelHash === (await workcellModelHash(robot, cell, assetsSha256)))
      return cell;
  return null;
}

export type IngredientLoad = Readonly<{
  massKg: number;
  forwardMm: number;
  lateralMm: number;
}>;

/** Pinned controller input for a one-carrier persistent fixture. */
type PersistentCellBase = Readonly<{
  [validatedCell]: true;
  schemaVersion: 1;
  cellId: string;
  runId: string;
  clampForceN: number;
  timestep: 0.002;
  modelHash: string;
  execution: Readonly<{
    backend: "native" | "browser";
    controllerSourceHash: string;
    controllerHash: string;
    runtimeHash: string;
  }>;
}>;

export type PersistentOvenCell = PersistentCellBase &
  Readonly<{
    fixture: "persistent-oven-rack/1";
    robot: RobotModel;
    ingredients: IngredientLoad;
  }>;
export type PersistentRackCell = PersistentCellBase &
  Readonly<{
    fixture: "persistent-rack/1";
    robot: RobotModel;
    ingredients: IngredientLoad;
  }>;
export type PersistentPanCell = PersistentCellBase &
  Readonly<{
    fixture: "persistent-pan-staging/1";
    robot: "fairino-fr10";
    ingredients: Readonly<{ massKg: 0; forwardMm: 0; lateralMm: 0 }>;
  }>;
export type EspressoMachine = "linea" | "eagle-one";
export type GrinderModel =
  | "option-o-lagom-casa"
  | "timemore-bricks-01s"
  | "fellow-opus-2"
  | "miicoffee-df64-gen2";
export function espressoVisualHash(appliance: EspressoMachine): string {
  switch (appliance) {
    case "linea":
      return LINEA_GLB_SHA256;
    case "eagle-one":
      return EAGLE_GLB_SHA256;
  }
}

function parseGrinderModel(value: unknown): GrinderModel {
  if (
    value === "option-o-lagom-casa" ||
    value === "timemore-bricks-01s" ||
    value === "fellow-opus-2" ||
    value === "miicoffee-df64-gen2"
  )
    return value;
  throw new Error("Unsupported grinder model.");
}

export type PersistentEspressoCell = Omit<
  PersistentCellBase,
  "clampForceN" | "timestep"
> &
  Readonly<{
    fixture: "persistent-espresso/1";
    appliance: EspressoMachine;
    grinder?: GrinderModel;
    grinderModelHash?: string;
    visualHash: string;
    robot?: never;
    ingredients?: never;
    clampForceN?: never;
    timestep?: never;
  }>;
/** The prepared pour-over station a human set out before the robot starts. */
export type PourOverStation = Readonly<{
  kettleWaterG: number;
  kettleWaterC: 93;
  coffeeG: 27;
  drainage: "nominal" | "reduced";
  fault: "none" | "lost-grip";
  grinder?: GrinderModel;
}>;
export type PersistentPourOverCell = Omit<PersistentCellBase, "clampForceN"> &
  Readonly<{
    fixture: "persistent-pour-over/1";
    robot: "fairino-fr10";
    station: PourOverStation;
    grinderModelHash?: string;
    ingredients?: never;
    clampForceN?: never;
    appliance?: never;
  }>;
export type PersistentCell =
  | PersistentOvenCell
  | PersistentPanCell
  | PersistentRackCell
  | PersistentEspressoCell
  | PersistentPourOverCell;

function parsePourOverStation(value: unknown): PourOverStation {
  const raw = object(value);
  keys(raw, [
    "kettleWaterG",
    "kettleWaterC",
    "coffeeG",
    "drainage",
    "fault",
    ...(raw.grinder === undefined ? [] : ["grinder"]),
  ]);
  const kettleWaterG = boundedLoad(
    raw.kettleWaterG,
    420,
    700,
    "Kettle water (g)",
  );
  if (
    !Number.isInteger(kettleWaterG) ||
    raw.kettleWaterC !== 93 ||
    raw.coffeeG !== 27 ||
    (raw.drainage !== "nominal" && raw.drainage !== "reduced") ||
    (raw.fault !== "none" && raw.fault !== "lost-grip")
  )
    throw new Error("Unsupported pour-over station.");
  const grinder =
    raw.grinder === undefined ? undefined : parseGrinderModel(raw.grinder);
  return Object.freeze({
    kettleWaterG,
    kettleWaterC: 93,
    coffeeG: 27,
    drainage: raw.drainage,
    fault: raw.fault,
    ...(grinder === undefined ? {} : { grinder }),
  });
}

export function parsePersistentCell(value: unknown): PersistentCell | null {
  try {
    const raw = object(value);
    if (raw.fixture === "persistent-pour-over/1") {
      keys(raw, [
        "schemaVersion",
        "fixture",
        "robot",
        "cellId",
        "runId",
        "station",
        "timestep",
        "modelHash",
        ...(raw.grinderModelHash === undefined ? [] : ["grinderModelHash"]),
        "execution",
      ]);
      const execution = parseExecutionIdentity(raw.execution, 7);
      if (
        raw.schemaVersion !== 1 ||
        raw.robot !== "fairino-fr10" ||
        raw.timestep !== 0.002 ||
        execution.backend === "unknown"
      )
        return null;
      const station = parsePourOverStation(raw.station);
      if (
        (station.grinder !== undefined) !==
        (raw.grinderModelHash !== undefined)
      )
        return null;
      return Object.freeze<PersistentPourOverCell>({
        [validatedCell]: true,
        schemaVersion: 1,
        fixture: "persistent-pour-over/1",
        robot: "fairino-fr10",
        cellId: requestId(raw.cellId),
        runId: requestId(raw.runId),
        station,
        timestep: 0.002,
        modelHash: hash(raw.modelHash),
        ...(raw.grinderModelHash === undefined
          ? {}
          : { grinderModelHash: hash(raw.grinderModelHash) }),
        execution: Object.freeze({
          backend: execution.backend,
          controllerSourceHash: execution.controllerSourceHash,
          controllerHash: execution.controllerHash,
          runtimeHash: execution.runtimeHash,
        }),
      });
    }
    if (raw.fixture === "persistent-espresso/1") {
      keys(raw, [
        "schemaVersion",
        "fixture",
        "cellId",
        "runId",
        "modelHash",
        "visualHash",
        ...(raw.appliance === undefined ? [] : ["appliance"]),
        ...(raw.grinder === undefined ? [] : ["grinder"]),
        ...(raw.grinderModelHash === undefined ? [] : ["grinderModelHash"]),
        "execution",
      ]);
      // Old retained Linea documents omitted the machine; normalize only here.
      const appliance = raw.appliance === undefined ? "linea" : raw.appliance;
      if (appliance !== "linea" && appliance !== "eagle-one") return null;
      const grinder =
        raw.grinder === undefined ? undefined : parseGrinderModel(raw.grinder);
      if ((grinder !== undefined) !== (raw.grinderModelHash !== undefined))
        return null;
      const execution = parseExecutionIdentity(raw.execution, 7);
      if (raw.schemaVersion !== 1 || execution.backend === "unknown")
        return null;
      return Object.freeze<PersistentEspressoCell>({
        [validatedCell]: true,
        schemaVersion: 1,
        fixture: "persistent-espresso/1",
        appliance,
        ...(grinder === undefined ? {} : { grinder }),
        ...(raw.grinderModelHash === undefined
          ? {}
          : { grinderModelHash: hash(raw.grinderModelHash) }),
        visualHash: hash(raw.visualHash),
        cellId: requestId(raw.cellId),
        runId: requestId(raw.runId),
        modelHash: hash(raw.modelHash),
        execution: Object.freeze({
          backend: execution.backend,
          controllerSourceHash: execution.controllerSourceHash,
          controllerHash: execution.controllerHash,
          runtimeHash: execution.runtimeHash,
        }),
      });
    }
    keys(raw, [
      "schemaVersion",
      "fixture",
      "cellId",
      "runId",
      "robot",
      "ingredients",
      "clampForceN",
      "timestep",
      "modelHash",
      "execution",
    ]);
    if (
      raw.schemaVersion !== 1 ||
      (raw.fixture !== "persistent-oven-rack/1" &&
        raw.fixture !== "persistent-rack/1" &&
        raw.fixture !== "persistent-pan-staging/1") ||
      raw.timestep !== 0.002
    )
      return null;
    const execution = parseExecutionIdentity(raw.execution, 7);
    if (execution.backend === "unknown") return null;
    const robot = parseRobotModel(raw.robot);
    const ingredients = Object.freeze(parseIngredientLoad(raw.ingredients));
    if (raw.fixture === "persistent-pan-staging/1") {
      if (
        robot !== "fairino-fr10" ||
        ingredients.massKg !== 0 ||
        ingredients.forwardMm !== 0 ||
        ingredients.lateralMm !== 0
      )
        return null;
      return Object.freeze<PersistentPanCell>({
        [validatedCell]: true,
        schemaVersion: 1,
        fixture: "persistent-pan-staging/1",
        cellId: requestId(raw.cellId),
        runId: requestId(raw.runId),
        robot,
        ingredients: Object.freeze({ massKg: 0, forwardMm: 0, lateralMm: 0 }),
        clampForceN: boundedLoad(raw.clampForceN, 20, 100, "Clamp force (N)"),
        timestep: 0.002,
        modelHash: hash(raw.modelHash),
        execution: Object.freeze({
          backend: execution.backend,
          controllerSourceHash: execution.controllerSourceHash,
          controllerHash: execution.controllerHash,
          runtimeHash: execution.runtimeHash,
        }),
      });
    }
    return Object.freeze<PersistentOvenCell | PersistentRackCell>({
      fixture: raw.fixture,
      [validatedCell]: true,
      schemaVersion: 1,
      cellId: requestId(raw.cellId),
      runId: requestId(raw.runId),
      robot,
      ingredients,
      clampForceN: boundedLoad(raw.clampForceN, 20, 100, "Clamp force (N)"),
      timestep: 0.002,
      modelHash: hash(raw.modelHash),
      execution: Object.freeze({
        backend: execution.backend,
        controllerSourceHash: execution.controllerSourceHash,
        controllerHash: execution.controllerHash,
        runtimeHash: execution.runtimeHash,
      }),
    });
  } catch {
    return null;
  }
}

export function sameIngredientLoad(
  first: IngredientLoad,
  second: IngredientLoad,
): boolean {
  return (
    first.massKg === second.massKg &&
    first.forwardMm === second.forwardMm &&
    first.lateralMm === second.lateralMm
  );
}

export function parseIngredientLoad(value: unknown): IngredientLoad {
  const raw = object(value);
  keys(raw, ["massKg", "forwardMm", "lateralMm"]);
  const forwardMm = boundedLoad(
    raw.forwardMm,
    -100,
    100,
    "Ingredient forward offset (mm)",
  );
  const lateralMm = boundedLoad(
    raw.lateralMm,
    -60,
    60,
    "Ingredient lateral offset (mm)",
  );
  if (!Number.isInteger(forwardMm) || !Number.isInteger(lateralMm))
    throw new Error("Ingredient offsets must use whole millimetres.");
  return {
    massKg: boundedLoad(raw.massKg, 0, 4, "Ingredient mass (kg)"),
    forwardMm,
    lateralMm,
  };
}

type RequestIdentity = Readonly<{
  [validatedRequest]: true;
  schemaVersion: 7;
  robot: RobotModel;
  ingredients: IngredientLoad;
  clampForceN: number;
  layout: PhysicsLayout;
  execution: PhysicsExecutionIdentity;
  source: "local-simulation";
  runId: string;
  attemptId: string;
  modelHash: string;
  timestep: 0.001 | 0.002;
}>;
type TransferCase = "nominal" | "blocked" | "unreachable" | "slip";
export type PhysicsRequest = RequestIdentity &
  (
    | Readonly<{ bakeryTaskId: "table-to-rack"; case: TransferCase }>
    | Readonly<{
        bakeryTaskId: "table-to-oven";
        case: TransferCase | "closed-door";
      }>
  );

export function exportPhysicsRequest(request: PhysicsRequest): string {
  const execution = request.execution;
  if (execution.backend === "unknown") return JSON.stringify(request, null, 2);
  return JSON.stringify(
    {
      schemaVersion: request.schemaVersion,
      robot: request.robot,
      ingredients: request.ingredients,
      clampForceN: request.clampForceN,
      source: request.source,
      runId: request.runId,
      attemptId: request.attemptId,
      modelHash: request.modelHash,
      layout: request.layout,
      bakeryTaskId: request.bakeryTaskId,
      case: request.case,
      timestep: request.timestep,
      execution: {
        backend: execution.backend,
        controllerSourceHash: execution.controllerSourceHash,
        controllerHash: execution.controllerHash,
        runtimeHash: execution.runtimeHash,
      },
    },
    null,
    2,
  );
}
type ReturnRequest = RequestIdentity &
  Readonly<{ bakeryTaskId: "oven-to-table"; case: "nominal" }>;
type LoadingRequest = RequestIdentity &
  Readonly<{ bakeryTaskId: "table-to-oven"; case: "nominal" }>;
type NativeRequest = PhysicsRequest | ReturnRequest;
export type PhysicsCyclePlan = Readonly<{
  [validatedCyclePlan]: true;
  request: LoadingRequest;
  returnRequest: ReturnRequest;
  handoffDigest: string;
}>;
export type PhysicsCyclePlanImport =
  | Readonly<{ kind: "accepted"; plan: PhysicsCyclePlan; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; plan?: never }>;
export type PhysicsFixture =
  | Readonly<{
      kind: "rack";
      pose?: never;
      doorAngle?: never;
      glbSha256?: never;
    }>
  | Readonly<{
      kind: "maruzen-oven" | "oven-and-rack";
      pose: PhysicsPose;
      doorAngle: number;
      glbSha256: typeof MARUZEN_GLB_SHA256;
    }>;
type TransferRecording<Request extends NativeRequest> = Readonly<{
  [validated]: true;
  schemaVersion: 4;
  kind: "bakery-physics-recording";
  request: Request;
  provenance: Readonly<{
    engine: "mujoco";
    version: "3.13.0" | "4.0.0";
    modelHash: string;
    robotGlbSha256: string;
    assumptions: readonly string[];
  }>;
  robotBase: PhysicsPose;
  fixture: PhysicsFixture;
  geometry: readonly PhysicsGeometry[];
  samples: readonly [PhysicsSample, ...PhysicsSample[]];
  events: readonly PhysicsEvent[];
  outcome: PhysicsOutcome;
}>;
export type PhysicsRecording = TransferRecording<PhysicsRequest>;
export type PhysicsMotion = PhysicsRecording | TransferRecording<ReturnRequest>;
export type PhysicsSequence = Readonly<{
  [validatedSequence]: true;
  schemaVersion: 2;
  kind: "bakery-physics-sequence";
  handoffDigest: string;
  loading: TransferRecording<LoadingRequest> &
    Readonly<{ outcome: Variant<PhysicsOutcome, "completed"> }>;
  unloading: TransferRecording<ReturnRequest>;
}>;
export type PhysicsReplay =
  PhysicsRecording | PhysicsSequence | PhysicsRackSequence;

/** Accepted cell poses. Operation identity belongs to the orchestration view. */
export type PersistentPhysicsMotion = Readonly<{
  [validatedPersistentMotion]: true;
  kind: "persistent-physics-motion";
  request: Readonly<{
    robot: RobotModel;
    timestep: 0.002;
    layout: PhysicsLayout;
  }>;
  robotBase: PhysicsPose;
  fixture: PhysicsFixture;
  geometry: readonly PhysicsGeometry[];
  samples: readonly [PhysicsSample, ...PhysicsSample[]];
  endStep: number;
}>;

export type PersistentPhysicsScene = Readonly<{
  [validatedPersistentScene]: true;
  cell: Exclude<
    PersistentCell,
    PersistentEspressoCell | PersistentPourOverCell
  >;
  robotBase: PhysicsPose;
  fixture: PhysicsFixture;
  geometry: readonly PhysicsGeometry[];
}>;

/** Parse the retained scene once. Each live frame reuses these exact mappings. */
export function parsePersistentPhysicsScene(
  cell: PersistentCell,
  setup: unknown,
  robotGlbSha256: unknown,
): PersistentPhysicsScene {
  if (cell.fixture === "persistent-espresso/1")
    throw new Error("An espresso cell uses the appliance visual.");
  if (cell.fixture === "persistent-pour-over/1")
    throw new Error("A pour-over station uses its own visual.");
  if (robotGlbSha256 !== ROBOTS[cell.robot].glbSha256)
    throw new Error("This Portal cannot display the retained robot visual.");
  const raw = object(setup);
  const fixture = parseFixture(raw.fixture, {
    bakeryTaskId:
      cell.fixture === "persistent-oven-rack/1"
        ? "table-to-oven"
        : "table-to-rack",
    case: "nominal",
  });
  if (
    cell.fixture === "persistent-oven-rack/1" &&
    fixture.kind !== "oven-and-rack"
  )
    throw new Error("The oven cell requires the combined fixture.");
  const geometry: PhysicsGeometry[] = [];
  for (const item of list(raw.geometry, 1, 128)) {
    const shape = parseGeometry(item);
    if (shape.name !== "cold_contents") geometry.push(shape);
    else if (cell.ingredients.massKg > 0)
      geometry.push({
        name: shape.name,
        body: shape.body,
        shape: shape.shape,
        size: shape.size,
        rgba: shape.rgba,
        pose: [
          -cell.ingredients.lateralMm / 1000,
          cell.ingredients.forwardMm / 1000,
          shape.pose[2],
          shape.pose[3],
          shape.pose[4],
          shape.pose[5],
          shape.pose[6],
        ],
      });
  }
  return {
    [validatedPersistentScene]: true,
    cell,
    robotBase: parsePose(raw.robotBase),
    fixture,
    geometry,
  };
}

/** Accepted samples can cover a complete operation or one live segment. */
export function parsePersistentPhysicsMotion(
  scene: PersistentPhysicsScene,
  rawSamples: readonly unknown[],
): PersistentPhysicsMotion {
  const samples = rawSamples.map(parseSample);
  const first = samples[0];
  if (first === undefined) throw new Error("An observation requires a sample.");
  let previous = first;
  for (const sample of samples.slice(1)) {
    if (sample.step <= previous.step || sample.step - previous.step > 32)
      throw new Error(
        "Accepted samples must be ordered without missing segments.",
      );
    previous = sample;
  }
  return {
    [validatedPersistentMotion]: true,
    kind: "persistent-physics-motion",
    request: {
      robot: scene.cell.robot,
      timestep: 0.002,
      layout: { kind: "fixed" },
    },
    robotBase: scene.robotBase,
    fixture: scene.fixture,
    geometry: scene.geometry,
    samples: [first, ...samples.slice(1)],
    endStep: previous.step,
  };
}
export type PhysicsReplayImport =
  | Readonly<{ kind: "accepted"; recording: PhysicsReplay; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; recording?: never }>;
export type PhysicsImport =
  | Readonly<{ kind: "accepted"; recording: PhysicsRecording; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; recording?: never }>;

export type PhysicsRequestImport =
  | Readonly<{ kind: "accepted"; request: PhysicsRequest; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; request?: never }>;

export function parsePhysicsRequest(text: string): PhysicsRequestImport {
  try {
    if (
      text.length > MAX_REQUEST_BYTES ||
      new TextEncoder().encode(text).length > MAX_REQUEST_BYTES
    ) {
      throw new Error("Request must be 4 KiB or smaller.");
    }
    return { kind: "accepted", request: parseRequest(JSON.parse(text)) };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof SyntaxError
          ? "Choose a native-prepared request JSON file."
          : error instanceof Error
            ? error.message
            : "Unable to read this request.",
    };
  }
}

export function parsePhysicsRecording(text: string): PhysicsImport {
  const result = parsePhysicsReplay(text);
  if (result.kind === "rejected") return result;
  if (result.recording.kind !== "bakery-physics-recording") {
    return {
      kind: "rejected",
      message:
        "This single-transfer input requires one outbound recording. Open a cycle in a two-task run.",
    };
  }
  return { kind: "accepted", recording: result.recording };
}

export function parsePhysicsReplay(text: string): PhysicsReplayImport {
  try {
    if (
      text.length > MAX_RECORDING_BYTES ||
      new TextEncoder().encode(text).length > MAX_RECORDING_BYTES
    ) {
      throw new Error("Recording must be 16 MiB or smaller.");
    }
    const raw = object(JSON.parse(text));
    if (raw.kind === "bakery-physics-rack-sequence") {
      return { kind: "accepted", recording: parseRackSequence(raw) };
    }
    const recording =
      raw.kind === "bakery-physics-sequence"
        ? parseSequence(raw)
        : parseRecording(raw, parseRequest(raw.request));
    return { kind: "accepted", recording };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof SyntaxError
          ? "This file is not valid JSON. The current replay has been kept."
          : error instanceof Error
            ? error.message
            : "Unable to read this recording.",
    };
  }
}

function parseRecording<Request extends NativeRequest>(
  raw: Record<string, unknown>,
  request: Request,
): TransferRecording<Request> {
  keys(raw, [
    "schemaVersion",
    "kind",
    "request",
    "provenance",
    "robotBase",
    "fixture",
    "geometry",
    "samples",
    "events",
    "outcome",
  ]);
  if (
    (raw.schemaVersion !== 2 &&
      raw.schemaVersion !== 3 &&
      raw.schemaVersion !== 4) ||
    raw.kind !== "bakery-physics-recording"
  ) {
    throw new Error(
      "Unsupported recording format. Export a version 4 physics recording.",
    );
  }
  const fixture = parseFixture(raw.fixture, request);
  const provenance = parseProvenance(
    raw.provenance,
    request.modelHash,
    raw.schemaVersion,
    request.execution,
    request.robot,
  );
  if (
    raw.schemaVersion === 4 &&
    ![3, 4, 5, 6, 7].includes(Number(object(raw.request).schemaVersion))
  )
    throw new Error(
      "A current recording requires a request version from 3 through 7.",
    );
  const robotBase = parsePose(raw.robotBase);
  const geometry = list(raw.geometry, 1, 128).map(parseGeometry);
  const names = new Set(geometry.map(geometryName));
  if (
    names.size !== geometry.length ||
    !["world", "tool", "jaw", "tray"].every(hasBody.bind(null, geometry))
  ) {
    throw new Error(
      "Geometry must have unique names and include fixtures, tool, jaw and tray.",
    );
  }
  if (fixture.kind === "oven-and-rack") {
    if (request.execution.controller !== "bakery-native")
      throw new Error("Combined fixtures require native execution provenance.");
    for (const name of [
      "rack_rail_left",
      "rack_rail_right",
      "mbco_rail_3_left",
      "mbco_rail_3_right",
      "table_top",
    ])
      if (!names.has(name))
        throw new Error(
          "Combined fixture requires table, oven and rack supports.",
        );
  }
  const samples = list(raw.samples, 1, 4096).map(parseSample);
  const first = samples[0];
  if (first === undefined || first.step !== 0)
    throw new Error("Recording must start at step zero.");
  const events = list(raw.events, 0, 128).map(parseEvent);
  const outcome = parseOutcome(raw.outcome);
  const steps = new Set<number>();
  let previous = -1;
  for (const sample of samples) {
    if (
      sample.step <= previous ||
      (previous >= 0 && (sample.step - previous) * request.timestep > 0.25)
    ) {
      throw new Error(
        "Samples must increase without gaps longer than 0.25 seconds.",
      );
    }
    previous = sample.step;
    steps.add(sample.step);
  }
  if (outcome.step !== previous || outcome.step * request.timestep > 60) {
    throw new Error(
      "The final sample must match the terminal outcome within 60 seconds.",
    );
  }
  previous = -1;
  for (const event of events) {
    if (event.step < previous || !steps.has(event.step)) {
      throw new Error("Events must be ordered and have matching pose samples.");
    }
    previous = event.step;
  }
  validateTransferEvents(events, outcome);
  return {
    [validated]: true,
    schemaVersion: 4,
    kind: "bakery-physics-recording",
    request,
    provenance,
    robotBase,
    fixture,
    geometry,
    samples: [first, ...samples.slice(1)],
    events,
    outcome,
  };
}

export function cyclePlanFromSequence(
  sequence: PhysicsSequence,
): PhysicsCyclePlan {
  return Object.freeze<PhysicsCyclePlan>({
    [validatedCyclePlan]: true,
    request: sequence.loading.request,
    returnRequest: sequence.unloading.request,
    handoffDigest: sequence.handoffDigest,
  });
}

export function parsePhysicsCyclePlan(text: string): PhysicsCyclePlanImport {
  try {
    if (
      text.length > MAX_REQUEST_BYTES ||
      new TextEncoder().encode(text).length > MAX_REQUEST_BYTES
    )
      throw new Error("Cycle setup must be 4 KiB or smaller.");
    return { kind: "accepted", plan: parseCyclePlan(JSON.parse(text)) };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof SyntaxError
          ? "Choose an exported cycle setup JSON file."
          : error instanceof Error
            ? error.message
            : "Unable to read this cycle setup.",
    };
  }
}

function parseCyclePlan(value: unknown): PhysicsCyclePlan {
  const raw = object(value);
  keys(raw, ["request", "returnRequest", "handoffDigest"]);
  const request = parseRequest(raw.request);
  const returnRequest = parseNativeRequest(raw.returnRequest);
  if (
    !isNominalLoadingRequest(request) ||
    returnRequest.bakeryTaskId !== "oven-to-table"
  )
    throw new Error(
      "A cold cycle requires nominal oven loading followed by return to the table.",
    );
  if (
    request.runId !== returnRequest.runId ||
    request.attemptId === returnRequest.attemptId ||
    request.modelHash !== returnRequest.modelHash ||
    request.robot !== returnRequest.robot ||
    !sameIngredientLoad(request.ingredients, returnRequest.ingredients) ||
    request.clampForceN !== returnRequest.clampForceN ||
    JSON.stringify(request.execution) !==
      JSON.stringify(returnRequest.execution) ||
    request.timestep !== returnRequest.timestep
  )
    throw new Error(
      "Cycle legs must share a run, model and timestep with distinct attempts.",
    );
  return Object.freeze<PhysicsCyclePlan>({
    [validatedCyclePlan]: true,
    request,
    returnRequest,
    handoffDigest: hash(raw.handoffDigest),
  });
}

function isNominalLoadingRequest(
  request: PhysicsRequest,
): request is LoadingRequest {
  return request.bakeryTaskId === "table-to-oven" && request.case === "nominal";
}

function parseSequence(raw: Record<string, unknown>): PhysicsSequence {
  keys(raw, ["schemaVersion", "kind", "handoffDigest", "loading", "unloading"]);
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
    throw new Error("Unsupported cold-cycle sequence version.");
  const loadingRaw = object(raw.loading);
  const unloadingRaw = object(raw.unloading);
  const plan = parseCyclePlan({
    request: loadingRaw.request,
    returnRequest: unloadingRaw.request,
    handoffDigest: raw.handoffDigest,
  });
  const loading = parseRecording(loadingRaw, plan.request);
  if (!isCompletedLoading(loading))
    throw new Error(
      "A cold cycle requires successful nominal oven loading first.",
    );
  const unloading = parseRecording(unloadingRaw, plan.returnRequest);
  if (!sameWorkcell(loading, unloading))
    throw new Error(
      "Cycle legs must use the same workcell geometry and fixture poses.",
    );
  if (!continuousPoses(loading, unloading))
    throw new Error(
      "Cycle boundary poses must match; the return cannot reset the workcell.",
    );
  return {
    [validatedSequence]: true,
    schemaVersion: 2,
    kind: "bakery-physics-sequence",
    handoffDigest: plan.handoffDigest,
    loading,
    unloading,
  };
}

function sameWorkcell(first: PhysicsMotion, second: PhysicsMotion): boolean {
  return (
    JSON.stringify(first.request.execution) ===
      JSON.stringify(second.request.execution) &&
    JSON.stringify(first.fixture) === JSON.stringify(second.fixture) &&
    JSON.stringify(first.robotBase) === JSON.stringify(second.robotBase) &&
    JSON.stringify(first.geometry) === JSON.stringify(second.geometry)
  );
}

function continuousPoses(
  previous: PhysicsMotion,
  next: PhysicsMotion,
): boolean {
  const last = previous.samples[previous.samples.length - 1];
  const first = next.samples[0];
  return (
    last !== undefined &&
    JSON.stringify(last.joints) === JSON.stringify(first.joints) &&
    JSON.stringify(last.tool) === JSON.stringify(first.tool) &&
    JSON.stringify(last.jaw) === JSON.stringify(first.jaw) &&
    JSON.stringify(last.tray) === JSON.stringify(first.tray)
  );
}

type ReturnedCycle = PhysicsSequence &
  Readonly<{
    unloading: TransferRecording<ReturnRequest> &
      Readonly<{
        outcome: Variant<PhysicsOutcome, "completed">;
      }>;
  }>;

function isReturnedCycle(cycle: PhysicsSequence): cycle is ReturnedCycle {
  return cycle.unloading.outcome.kind === "completed";
}

function isRackRecording(
  recording: PhysicsRecording,
): recording is TransferRecording<
  VariantBy<PhysicsRequest, "bakeryTaskId", "table-to-rack">
> {
  return recording.request.bakeryTaskId === "table-to-rack";
}

export type PhysicsRackSequence = Readonly<{
  [validatedRackSequence]: true;
  kind: "bakery-physics-rack-sequence";
  schemaVersion: 2;
  loadingHandoffDigest: string;
  loading: PhysicsSequence["loading"];
  unloading: ReturnedCycle["unloading"];
  handoffDigest: string;
  racking: TransferRecording<
    VariantBy<PhysicsRequest, "bakeryTaskId", "table-to-rack">
  >;
}>;

const validatedRackPlan: unique symbol = Symbol("validated rack cycle plan");
export type PhysicsRackPlan = Readonly<{
  [validatedRackPlan]: true;
  cycle: PhysicsCyclePlan;
  rackRequest: PhysicsRackSequence["racking"]["request"];
  rackHandoffDigest: string;
}>;

export function rackPlanFromSequence(
  sequence: PhysicsRackSequence,
): PhysicsRackPlan {
  const cycle = Object.freeze<PhysicsCyclePlan>({
    [validatedCyclePlan]: true,
    request: sequence.loading.request,
    returnRequest: sequence.unloading.request,
    handoffDigest: sequence.loadingHandoffDigest,
  });
  return Object.freeze<PhysicsRackPlan>({
    [validatedRackPlan]: true,
    cycle,
    rackRequest: sequence.racking.request,
    rackHandoffDigest: sequence.handoffDigest,
  });
}

export function parsePhysicsRackPlan(
  text: string,
):
  | Readonly<{ kind: "accepted"; plan: PhysicsRackPlan; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; plan?: never }> {
  try {
    if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES * 3)
      throw new Error("Rack cycle requests must be 12 KiB or smaller.");
    const raw = object(JSON.parse(text));
    keys(raw, ["cycle", "rackRequest", "rackHandoffDigest"]);
    const cycle = parsePhysicsCyclePlan(JSON.stringify(raw.cycle));
    if (cycle.kind === "rejected") return cycle;
    const rack = parseRequest(raw.rackRequest);
    const loading = cycle.plan.request;
    if (
      rack.bakeryTaskId !== "table-to-rack" ||
      rack.runId !== loading.runId ||
      rack.modelHash !== loading.modelHash ||
      rack.robot !== loading.robot ||
      !sameIngredientLoad(rack.ingredients, loading.ingredients) ||
      rack.clampForceN !== loading.clampForceN ||
      rack.timestep !== loading.timestep ||
      JSON.stringify(rack.execution) !== JSON.stringify(loading.execution) ||
      rack.attemptId === loading.attemptId ||
      rack.attemptId === cycle.plan.returnRequest.attemptId
    )
      throw new Error(
        "Rack continuation must retain the cycle identity and use its own attempt.",
      );
    return {
      kind: "accepted",
      plan: {
        [validatedRackPlan]: true,
        cycle: cycle.plan,
        rackRequest: rack,
        rackHandoffDigest: hash(raw.rackHandoffDigest),
      },
    };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof Error
          ? error.message
          : "Unable to read rack cycle requests.",
    };
  }
}

export function parsePhysicsRackSequence(text: string):
  | Readonly<{
      kind: "accepted";
      sequence: PhysicsRackSequence;
      message?: never;
    }>
  | Readonly<{ kind: "rejected"; message: string; sequence?: never }> {
  const parsed = parsePhysicsReplay(text);
  if (parsed.kind === "rejected") return parsed;
  if (parsed.recording.kind !== "bakery-physics-rack-sequence")
    return { kind: "rejected", message: "Choose a native rack sequence." };
  return { kind: "accepted", sequence: parsed.recording };
}

function parseRackSequence(raw: Record<string, unknown>): PhysicsRackSequence {
  keys(raw, [
    "kind",
    "schemaVersion",
    "loadingHandoffDigest",
    "loading",
    "unloading",
    "handoffDigest",
    "racking",
  ]);
  if (
    raw.kind !== "bakery-physics-rack-sequence" ||
    (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
  )
    throw new Error("Choose a completed native rack sequence.");
  const cycle = parseSequence({
    kind: "bakery-physics-sequence",
    schemaVersion: raw.schemaVersion,
    handoffDigest: raw.loadingHandoffDigest,
    loading: raw.loading,
    unloading: raw.unloading,
  });
  const rackRaw = object(raw.racking);
  const request = parseRequest(rackRaw.request);
  const racking = parseRecording(rackRaw, request);
  const returned = cycle.unloading;
  if (
    !isReturnedCycle(cycle) ||
    !isRackRecording(racking) ||
    returned.fixture.kind !== "oven-and-rack" ||
    racking.fixture.kind !== "oven-and-rack"
  )
    throw new Error(
      "Rack continuation requires successful retrieval in the combined fixture.",
    );
  if (
    request.runId !== returned.request.runId ||
    request.modelHash !== returned.request.modelHash ||
    request.robot !== returned.request.robot ||
    !sameIngredientLoad(request.ingredients, returned.request.ingredients) ||
    request.clampForceN !== returned.request.clampForceN ||
    request.timestep !== returned.request.timestep ||
    request.attemptId === returned.request.attemptId ||
    request.attemptId === cycle.loading.request.attemptId ||
    !sameWorkcell(returned, racking)
  )
    throw new Error(
      "Rack continuation must retain the run, model, runtime and workcell geometry.",
    );
  if (!continuousPoses(returned, racking))
    throw new Error("Rack continuation cannot reset the returned workcell.");
  return {
    [validatedRackSequence]: true,
    kind: "bakery-physics-rack-sequence",
    schemaVersion: 2,
    loadingHandoffDigest: cycle.handoffDigest,
    loading: cycle.loading,
    unloading: cycle.unloading,
    handoffDigest: hash(raw.handoffDigest),
    racking,
  };
}

export function isCompletedLoading(
  recording: PhysicsRecording,
): recording is PhysicsSequence["loading"] {
  return (
    isNominalLoadingRequest(recording.request) &&
    recording.outcome.kind === "completed"
  );
}

function parseRequest(value: unknown): PhysicsRequest {
  const request = parseNativeRequest(value);
  if (request.bakeryTaskId === "oven-to-table")
    throw new Error("Oven returns require a complete cold-cycle sequence.");
  return request;
}

function boundedLoad(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return value;
}

function parseNativeRequest(value: unknown): NativeRequest {
  const raw = object(value);
  keys(raw, [
    "schemaVersion",
    "source",
    "runId",
    "bakeryTaskId",
    "attemptId",
    "modelHash",
    "case",
    "timestep",
    ...(raw.schemaVersion === 1 ? [] : ["execution"]),
    ...(raw.schemaVersion === 4 ||
    raw.schemaVersion === 5 ||
    raw.schemaVersion === 6 ||
    raw.schemaVersion === 7
      ? ["layout"]
      : []),
    ...(raw.schemaVersion === 5 ||
    raw.schemaVersion === 6 ||
    raw.schemaVersion === 7
      ? ["robot"]
      : []),
    ...(raw.schemaVersion === 6 ? ["payloadKg", "clampForceN"] : []),
    ...(raw.schemaVersion === 7 ? ["ingredients", "clampForceN"] : []),
  ]);
  if (
    (raw.schemaVersion !== 1 &&
      raw.schemaVersion !== 2 &&
      raw.schemaVersion !== 3 &&
      raw.schemaVersion !== 4 &&
      raw.schemaVersion !== 5 &&
      raw.schemaVersion !== 6 &&
      raw.schemaVersion !== 7) ||
    raw.source !== "local-simulation" ||
    (raw.bakeryTaskId !== "table-to-rack" &&
      raw.bakeryTaskId !== "table-to-oven" &&
      raw.bakeryTaskId !== "oven-to-table") ||
    (raw.timestep !== 0.001 && raw.timestep !== 0.002) ||
    (raw.case !== "nominal" &&
      raw.case !== "blocked" &&
      raw.case !== "unreachable" &&
      raw.case !== "slip" &&
      raw.case !== "closed-door")
  ) {
    throw new Error("Unsupported local robot experiment request.");
  }
  const identity: RequestIdentity = {
    [validatedRequest]: true,
    schemaVersion: 7,
    robot:
      raw.schemaVersion === 5 ||
      raw.schemaVersion === 6 ||
      raw.schemaVersion === 7
        ? parseRobotModel(raw.robot)
        : "fairino-fr10",
    ingredients:
      raw.schemaVersion === 7
        ? parseIngredientLoad(raw.ingredients)
        : parseIngredientLoad({
            massKg:
              1 +
              (raw.schemaVersion === 6
                ? boundedLoad(raw.payloadKg, 0, 3, "Added payload (kg)")
                : 0),
            forwardMm: 0,
            lateralMm: 0,
          }),
    clampForceN:
      raw.schemaVersion === 6 || raw.schemaVersion === 7
        ? boundedLoad(raw.clampForceN, 20, 100, "Clamp force (N)")
        : 100,
    layout:
      raw.schemaVersion === 4 ||
      raw.schemaVersion === 5 ||
      raw.schemaVersion === 6 ||
      raw.schemaVersion === 7
        ? parsePhysicsLayout(raw.layout)
        : { kind: "fixed" },
    execution:
      raw.schemaVersion === 1
        ? {
            controller: "python-reference",
            backend: "unknown",
            controllerSourceHash: null,
          }
        : parseExecutionIdentity(raw.execution, raw.schemaVersion),
    source: "local-simulation",
    runId: requestId(raw.runId),
    attemptId: requestId(raw.attemptId),
    modelHash: hash(raw.modelHash),
    timestep: raw.timestep,
  };
  if (
    identity.layout.kind === "rack-translation" &&
    (raw.bakeryTaskId !== "table-to-rack" || raw.case !== "nominal")
  )
    throw new Error(
      "Layout experiments require a standalone nominal rack transfer.",
    );
  if (raw.bakeryTaskId === "oven-to-table") {
    if (raw.case !== "nominal")
      throw new Error("Cold-cycle returns require a nominal request.");
    return {
      [validatedRequest]: true,
      schemaVersion: identity.schemaVersion,
      robot: identity.robot,
      ingredients: identity.ingredients,
      clampForceN: identity.clampForceN,
      execution: identity.execution,
      source: identity.source,
      runId: identity.runId,
      attemptId: identity.attemptId,
      modelHash: identity.modelHash,
      layout: identity.layout,
      timestep: identity.timestep,
      bakeryTaskId: "oven-to-table",
      case: "nominal",
    };
  }
  if (raw.bakeryTaskId === "table-to-oven") {
    return {
      [validatedRequest]: true,
      schemaVersion: identity.schemaVersion,
      robot: identity.robot,
      ingredients: identity.ingredients,
      clampForceN: identity.clampForceN,
      execution: identity.execution,
      source: identity.source,
      runId: identity.runId,
      attemptId: identity.attemptId,
      modelHash: identity.modelHash,
      layout: identity.layout,
      timestep: identity.timestep,
      bakeryTaskId: "table-to-oven",
      case: raw.case,
    };
  }
  if (raw.case === "closed-door")
    throw new Error("A closed-door case requires an oven task.");
  return {
    [validatedRequest]: true,
    schemaVersion: identity.schemaVersion,
    robot: identity.robot,
    ingredients: identity.ingredients,
    clampForceN: identity.clampForceN,
    execution: identity.execution,
    source: identity.source,
    runId: identity.runId,
    attemptId: identity.attemptId,
    modelHash: identity.modelHash,
    layout: identity.layout,
    timestep: identity.timestep,
    bakeryTaskId: "table-to-rack",
    case: raw.case,
  };
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error(
      "Request IDs must contain 1–80 letters, digits, underscores or hyphens.",
    );
  }
  return value;
}

function parseExecutionIdentity(
  value: unknown,
  version: 2 | 3 | 4 | 5 | 6 | 7,
): PhysicsExecutionIdentity {
  const raw = object(value);
  if (version === 2) {
    if (raw.controller === "python-reference") {
      keys(raw, ["controller"]);
      return {
        controller: "python-reference",
        backend: "unknown",
        controllerSourceHash: null,
      };
    }
    keys(raw, ["controller", "controllerHash", "runtimeHash"]);
    if (raw.controller !== "bakery-native")
      throw new Error("Unsupported controller identity.");
    return {
      controller: "bakery-native",
      backend: "unknown",
      controllerSourceHash: null,
      controllerHash: hash(raw.controllerHash),
      runtimeHash: hash(raw.runtimeHash),
    };
  }
  const controllerField = raw.controller === undefined ? [] : ["controller"];
  if (raw.backend === "unknown" && raw.controller === "python-reference") {
    keys(raw, ["backend", "controllerSourceHash", ...controllerField]);
    if (raw.controllerSourceHash !== null)
      throw new Error("Historical controller identity is invalid.");
    return {
      controller: "python-reference",
      backend: "unknown",
      controllerSourceHash: null,
    };
  }
  keys(raw, [
    "backend",
    "controllerSourceHash",
    "controllerHash",
    "runtimeHash",
    ...controllerField,
  ]);
  if (raw.controller !== undefined && raw.controller !== "bakery-native")
    throw new Error("Unsupported controller identity.");
  if (raw.backend === "unknown") {
    if (raw.controllerSourceHash !== null)
      throw new Error("Historical controller source identity is invalid.");
    return {
      controller: "bakery-native",
      backend: "unknown",
      controllerSourceHash: null,
      controllerHash: hash(raw.controllerHash),
      runtimeHash: hash(raw.runtimeHash),
    };
  }
  if (raw.backend !== "native" && raw.backend !== "browser")
    throw new Error("Unsupported simulation backend.");
  return {
    controller: "bakery-native",
    backend: raw.backend,
    controllerSourceHash: hash(raw.controllerSourceHash),
    controllerHash: hash(raw.controllerHash),
    runtimeHash: hash(raw.runtimeHash),
  };
}

function parseFixture(
  value: unknown,
  request: Pick<NativeRequest, "bakeryTaskId" | "case">,
): PhysicsFixture {
  const raw = object(value);
  if (
    request.bakeryTaskId === "table-to-rack" &&
    raw.kind !== "oven-and-rack"
  ) {
    keys(raw, ["kind"]);
    if (raw.kind !== "rack")
      throw new Error("Rack task requires a rack fixture.");
    return { kind: "rack" };
  }
  keys(raw, ["kind", "pose", "doorAngle", "glbSha256"]);
  const doorAngle = request.case === "closed-door" ? 0 : (100 * Math.PI) / 180;
  if (
    (raw.kind !== "maruzen-oven" && raw.kind !== "oven-and-rack") ||
    typeof raw.glbSha256 !== "string" ||
    (raw.glbSha256 !== MARUZEN_GLB_SHA256 &&
      !EARLIER_MARUZEN_GLB_SHA256.has(raw.glbSha256)) ||
    Math.abs(number(raw.doorAngle, 0, 1.92) - doorAngle) > 1e-8
  ) {
    throw new Error(
      "Oven task requires the matching Maruzen visual and fixed-door pose.",
    );
  }
  return {
    kind: raw.kind,
    pose: parsePose(raw.pose),
    doorAngle,
    glbSha256: MARUZEN_GLB_SHA256,
  };
}

function parseProvenance(
  value: unknown,
  modelHash: string,
  schemaVersion: 2 | 3 | 4,
  execution: PhysicsExecutionIdentity,
  robot: RobotModel,
): PhysicsRecording["provenance"] {
  const raw = object(value);
  const native = schemaVersion === 3 && raw.controller === "bakery-native";
  const identityFields =
    schemaVersion === 2 || schemaVersion === 4
      ? []
      : native
        ? ["controller", "controllerHash", "runtimeHash"]
        : ["controller"];
  keys(raw, [
    "engine",
    "version",
    "modelHash",
    "robotGlbSha256",
    "assumptions",
    ...identityFields,
  ]);
  if (schemaVersion === 3 && !native && raw.controller !== "python-reference")
    throw new Error("Unsupported native controller identity.");
  if (
    schemaVersion === 3 &&
    (execution.controller !== raw.controller ||
      (native &&
        (execution.controllerHash !== raw.controllerHash ||
          execution.runtimeHash !== raw.runtimeHash)))
  )
    throw new Error(
      "Recording controller/runtime differs from its pinned request.",
    );
  if (schemaVersion === 2 && execution.controller !== "python-reference")
    throw new Error("Historical recording controller is invalid.");
  if (
    raw.engine !== "mujoco" ||
    (raw.version !== "3.13.0" && raw.version !== "4.0.0") ||
    raw.modelHash !== modelHash ||
    raw.robotGlbSha256 !== ROBOTS[robot].glbSha256
  ) {
    throw new Error(
      "Recording model, engine or selected robot visual does not match the supported replay format.",
    );
  }
  const common = {
    engine: "mujoco" as const,
    version: raw.version,
    modelHash,
    robotGlbSha256: ROBOTS[robot].glbSha256,
    assumptions: list(raw.assumptions, 1, 16).map(assumption),
  } as const;
  return common;
}

function parseGeometry(value: unknown): PhysicsGeometry {
  const raw = object(value);
  keys(raw, ["name", "body", "shape", "size", "pose", "rgba"]);
  if (
    (raw.body !== "world" &&
      raw.body !== "tool" &&
      raw.body !== "jaw" &&
      raw.body !== "tray") ||
    (raw.shape !== "box" && raw.shape !== "cylinder" && raw.shape !== "capsule")
  )
    throw new Error("Unsupported workcell geometry.");
  const size = numbers(raw.size, 3, 0, 10);
  const color = numbers(raw.rgba, 4, 0, 1);
  const [x, y, z] = triple(size);
  if (x <= 0 || y <= 0 || (raw.shape === "box" && z <= 0))
    throw new Error("Geometry dimensions must be positive.");
  return {
    name: label(raw.name, 128),
    body: raw.body,
    shape: raw.shape,
    size: [x, y, z],
    pose: parsePose(raw.pose),
    rgba: quadruple(color),
  };
}

function parseSample(value: unknown): PhysicsSample {
  const raw = object(value);
  keys(raw, ["step", "joints", "tool", "jaw", "tray"]);
  const joints = numbers(raw.joints, 6, -8, 8);
  const [a, b, c, d, e, f] = joints;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined
  )
    throw new Error("Expected six arm joints.");
  return {
    step: sampleStep(raw.step),
    joints: [a, b, c, d, e, f],
    tool: parsePose(raw.tool),
    jaw: parsePose(raw.jaw),
    tray: parsePose(raw.tray),
  };
}

function parseEvent(value: unknown): PhysicsEvent {
  const raw = object(value);
  keys(raw, ["step", "kind", "label"]);
  if (
    raw.kind !== "phase" &&
    raw.kind !== "pickup" &&
    raw.kind !== "placement" &&
    raw.kind !== "failure"
  )
    throw new Error("Unknown recording event.");
  return { step: step(raw.step), kind: raw.kind, label: label(raw.label, 160) };
}

function outcomeMargins(
  raw: Record<string, unknown>,
): Readonly<{ margins?: OperationMargins }> {
  return raw.margins === undefined
    ? {}
    : { margins: parseOperationMargins(raw.margins) };
}

function parseOutcome(value: unknown): PhysicsOutcome {
  const raw = object(value);
  const terminalStep = step(raw.step);
  switch (raw.kind) {
    case "completed": {
      keys(raw, ["kind", "step", "evidence", "margins"], ["margins"]);
      const evidence = object(raw.evidence);
      keys(evidence, [
        "positionErrorM",
        "orientationErrorRad",
        "linearSpeedMps",
        "angularSpeedRadps",
        "settledSeconds",
      ]);
      return {
        kind: "completed",
        step: terminalStep,
        evidence: {
          positionErrorM: number(evidence.positionErrorM, 0, 0.01),
          orientationErrorRad: number(
            evidence.orientationErrorRad,
            0,
            Math.PI / 36,
          ),
          linearSpeedMps: number(evidence.linearSpeedMps, 0, 0.02),
          angularSpeedRadps: number(evidence.angularSpeedRadps, 0, 0.05),
          settledSeconds: number(evidence.settledSeconds, 0.5, 60),
        },
        ...outcomeMargins(raw),
      };
    }
    case "failed":
      keys(
        raw,
        ["kind", "step", "reason", "trayDisposition", "margins"],
        ["margins"],
      );
      if (
        raw.trayDisposition !== "source" &&
        raw.trayDisposition !== "gripped" &&
        raw.trayDisposition !== "destination" &&
        raw.trayDisposition !== "unknown"
      )
        throw new Error("Unknown tray disposition.");
      return {
        kind: "failed",
        step: terminalStep,
        reason: label(raw.reason, 2000),
        trayDisposition: raw.trayDisposition,
        ...outcomeMargins(raw),
      };
    case "execution-error":
      keys(raw, ["kind", "step", "message"]);
      return {
        kind: "execution-error",
        step: terminalStep,
        message: label(raw.message, 2000),
      };
    default:
      throw new Error("Recording requires one terminal outcome.");
  }
}

function parsePose(value: unknown): PhysicsPose {
  const [x, y, z, w, qx, qy, qz] = numbers(value, 7, -100, 100);
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    w === undefined ||
    qx === undefined ||
    qy === undefined ||
    qz === undefined
  )
    throw new Error("Expected a seven-value pose.");
  const norm = Math.hypot(w, qx, qy, qz);
  if (Math.abs(norm - 1) > 0.001)
    throw new Error("Pose quaternions must be unit length.");
  // Preserve unit quaternions on re-import so evidence identity stays stable.
  const divisor = Math.abs(norm - 1) <= Number.EPSILON * 8 ? 1 : norm;
  return [x, y, z, w / divisor, qx / divisor, qy / divisor, qz / divisor];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a recording object.");
  return value as Record<string, unknown>;
}
/** Exactly the `expected` fields; an `optional` one may be absent. */
function keys(
  raw: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  const required = expected.filter((key) => !optional.includes(key));
  if (
    !Object.keys(raw).every((key) => expected.includes(key)) ||
    !required.every(Object.hasOwn.bind(null, raw))
  )
    throw new Error("Unexpected or missing fields in physics JSON.");
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error("Recording collection has an invalid size.");
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Recording contains an invalid numeric value.");
  // JSON exports normalize negative zero; normalize it on first import too.
  return value === 0 ? 0 : value;
}
function numbers(
  value: unknown,
  length: number,
  min: number,
  max: number,
): number[] {
  return list(value, length, length).map(boundedNumber.bind(null, min, max));
}
function boundedNumber(min: number, max: number, value: unknown): number {
  return number(value, min, max);
}
function triple(values: number[]): Vector3 {
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined)
    throw new Error("Expected three values.");
  return [x, y, z];
}
function quadruple(
  values: number[],
): readonly [number, number, number, number] {
  const [x, y, z, w] = values;
  if (x === undefined || y === undefined || z === undefined || w === undefined)
    throw new Error("Expected four values.");
  return [x, y, z, w];
}
function step(value: unknown): number {
  const result = number(value, 0, 60000);
  if (!Number.isSafeInteger(result))
    throw new Error("Physics steps must be integers.");
  return result;
}
// Persistent samples use the cell's absolute clock, beyond one operation.
function sampleStep(value: unknown): number {
  const result = number(value, 0, Number.MAX_SAFE_INTEGER / 2000);
  if (!Number.isSafeInteger(result))
    throw new Error("Physics sample steps must be integers.");
  return result;
}
function label(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  )
    throw new Error("Recording text is missing or too long.");
  return value.trim();
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Expected a SHA-256 model fingerprint.");
  return value;
}
function assumption(value: unknown): string {
  return label(value, 500);
}
function geometryName(geometry: PhysicsGeometry): string {
  return geometry.name;
}
function hasBody(geometry: readonly PhysicsGeometry[], body: string): boolean {
  for (const item of geometry) if (item.body === body) return true;
  return false;
}
type TransferEvidence =
  | Readonly<{ kind: "source" }>
  | Readonly<{ kind: "carried"; pickupStep: number }>
  | Readonly<{ kind: "placed" | "failed"; terminalStep: number }>;

function validateTransferEvents(
  events: readonly PhysicsEvent[],
  outcome: PhysicsOutcome,
): void {
  let evidence: TransferEvidence = { kind: "source" };
  for (const event of events) {
    if (evidence.kind === "placed" || evidence.kind === "failed") {
      throw new Error(
        "Recording contains events after termination. Export the complete native run again.",
      );
    }
    switch (event.kind) {
      case "phase":
        break;
      case "pickup":
        if (evidence.kind !== "source") {
          throw new Error("A transfer can pick up its tray only once.");
        }
        evidence = { kind: "carried", pickupStep: event.step };
        break;
      case "placement":
        if (evidence.kind !== "carried" || event.step <= evidence.pickupStep) {
          throw new Error("Placement requires one earlier pickup observation.");
        }
        evidence = { kind: "placed", terminalStep: event.step };
        break;
      case "failure":
        evidence = { kind: "failed", terminalStep: event.step };
        break;
      default:
        assertNever(event.kind, "Unexpected physics evidence");
    }
  }
  switch (outcome.kind) {
    case "completed":
      if (evidence.kind === "placed" && evidence.terminalStep === outcome.step)
        return;
      throw new Error(
        "Completed transfers require a final placement observation at the outcome step.",
      );
    case "failed":
    case "execution-error":
      if (evidence.kind === "failed" && evidence.terminalStep === outcome.step)
        return;
      throw new Error(
        "Failed transfers require a final failure observation at the outcome step.",
      );
    default:
      assertNever(outcome, "Unexpected physics evidence");
  }
}

export const EAGLE_GLB_SHA256 =
  "a2e90975a7439c05cdeb31e2d5fbee2002c3c8b6c5475800f8d7fddbf5d6cc74";
