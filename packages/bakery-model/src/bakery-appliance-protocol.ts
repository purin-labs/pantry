import type { StrictUnion } from "@seams/type-utils";
import { canonicalJson, isRecord } from "@seams/std";
import { checkpointBody } from "./bakery-checkpoint.ts";

// Generated from assets/bakery-mujoco/appliances.json, as are the cases of
// parseName: edit the table, then run
// node scripts/bakery-robots/appliance-registry.mjs.
export type ApplianceName =
  | "la-marzocco-linea-classic-s-2g"
  | "victoria-arduino-eagle-one-2g"
  | "victoria-arduino-e1-prima"
  | "maruzen-mih-02c"
  | "vollrath-59500p"
  | "panasonic-kz-ck1402"
  | "rinnai-rsb-150pj"
  | "hoshizaki-rt-120snj"
  | "maruzen-mbco-5e"
  | "aicoh-ms-30"
  | "hobart-hl200"
  | "vitamix-quiet-one"
  | "waring-wsg60"
  | "severin-sm-3587"
  | "ohaus-ranger-3000"
  | "winterhalter-uc-l"
  | "option-o-lagom-casa"
  | "timemore-bricks-01s"
  | "fellow-opus-2"
  | "miicoffee-df64-gen2"
  | "hoshizaki-im-35p"
  | "pastry-bench";
export type ApplianceBatch = Readonly<{
  identity: string;
  mass_kg: number;
  temperature_c: number;
  specific_heat: number;
  density_kg_l: number;
  resistance: number;
}>;
export type ApplianceContents =
  | Readonly<{ kind: "empty"; batch?: never }>
  | Readonly<{ kind: "loaded"; batch: ApplianceBatch }>;
export type EspressoGroup = "left" | "right";
export type EspressoOutlet = EspressoGroup | "hot-water";
export type EspressoDoseSlot = "one" | "two";
export type ApplianceProgram = StrictUnion<
  | Readonly<{
      kind: "espresso-shot-preset";
      group: EspressoGroup;
      slot: EspressoDoseSlot;
    }>
  | Readonly<{ kind: "espresso-hot-water-preset" }>
  | Readonly<{ kind: "espresso-hot-water"; duration_s: number }>
  | Readonly<{ kind: "espresso-warmup"; coffee_c: number; steam_c: number }>
  | Readonly<{
      kind: "espresso-shot";
      group: EspressoGroup;
      duration_s: number;
    }>
  | Readonly<{ kind: "planetary"; setting: number; duration_s: number }>
  | Readonly<{ kind: "blend"; percent: number; duration_s: number }>
  | Readonly<{ kind: "grind" | "cold-mix"; duration_s: number }>
  | Readonly<{ kind: "heated-mix" | "preheat"; target_c: number }>
  | Readonly<{ kind: "hob-power"; percent: number; duration_s: number }>
  | Readonly<{
      kind: "hob-temperature" | "bake";
      target_c: number;
      duration_s: number;
    }>
  | Readonly<{
      kind: "press-dough-block";
      target_height_mm: number;
      duration_s: number;
    }>
  | Readonly<{
      kind: "sheet-shortcrust";
      target_thickness_mm: number;
      duration_s: number;
    }>
  | Readonly<{
      kind: "drape-puff-lid";
      crimp_force_n: number;
      duration_s: number;
    }>
  | Readonly<{ kind: "refrigerate" | "make-ice" | "weigh" | "wash" }>
>;
export type ApplianceAction = StrictUnion<
  | Readonly<{ kind: "inspect" }>
  | Readonly<{
      kind: "move-cup";
      outlet: EspressoOutlet;
      position: "placed" | "removed";
    }>
  | Readonly<{ kind: "empty-cup" | "serve-cup"; outlet: EspressoOutlet }>
  | Readonly<{
      kind: "set-shot-dose";
      group: EspressoGroup;
      slot: EspressoDoseSlot;
      duration_s: number;
    }>
  | Readonly<{ kind: "set-hot-water-dose"; duration_s: number }>
  | Readonly<{ kind: "stop-hot-water" }>
  | Readonly<{
      kind: "portafilter";
      group: EspressoGroup;
      position: "unlocked" | "removed" | "seated" | "locked";
    }>
  | Readonly<{ kind: "steam"; group: EspressoGroup; open: boolean }>
  | Readonly<{
      kind: "steam-wand";
      group: EspressoGroup;
      angle_degrees: number;
    }>
  | Readonly<{ kind: "stop-shot"; group: EspressoGroup }>
  | Readonly<{ kind: "water-supply"; available: boolean }>
  | Readonly<{
      kind: "move-attachment";
      part: "bowl" | "beater" | "whip";
      position: readonly [number, number, number];
      quaternion: readonly [number, number, number, number];
    }>
  | Readonly<{
      kind: "grasp-attachment" | "release-attachment";
      part: "bowl" | "beater" | "whip";
    }>
  | Readonly<{
      kind: "engage-attachment" | "move-to-attachment";
      part: "bowl" | "beater" | "whip";
      parking: boolean;
    }>
  | Readonly<{
      kind: "require";
      state: "ready" | "complete" | "stable" | "stopped";
    }>
  | Readonly<{
      kind: "move-to-slot";
      slot:
        | Readonly<{ kind: "oven"; level: number }>
        | Readonly<{ kind: "refrigerator"; right: boolean; level: number }>;
    }>
  | Readonly<{ kind: "advance"; seconds: number }>
  | Readonly<{ kind: "start"; program: ApplianceProgram }>
  | Readonly<{
      kind:
        | "stop"
        | "reset"
        | "resume"
        | "cooldown"
        | "remove-contents"
        | "grasp"
        | "release"
        | "engage"
        | "tare"
        | "zero"
        | "prepare-wash";
    }>
  | Readonly<{ kind: "set-contents"; contents: ApplianceContents }>
  | Readonly<{ kind: "door"; open: boolean; right: boolean }>
  | Readonly<{ kind: "lid" | "guard"; open: boolean }>
  | Readonly<{ kind: "bowl-lift"; raised: boolean }>
  | Readonly<{ kind: "rack"; extended: boolean }>
  | Readonly<{
      kind: "move";
      position: readonly [number, number, number];
      quaternion: readonly [number, number, number, number];
    }>
  | Readonly<{ kind: "drain-blocked"; blocked: boolean }>
  | Readonly<{
      kind: "load-part" | "unload-part" | "grasp-part";
      part: "bowl" | "beater";
    }>
  | Readonly<{ kind: "grind-dial"; radians: number }>
  | Readonly<{ kind: "purge"; active: boolean }>
  | Readonly<{ kind: "bench-flour"; dusted: boolean }>
>;
export type ApplianceRequest = Readonly<{
  appliance: ApplianceName;
  runId: string;
  attemptId: string;
  file: string;
}>;
export type AppliancePose = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export type ApplianceDisplay = Readonly<{
  name: string;
  text: string;
  lamp: boolean;
  pose: AppliancePose;
  width: number;
  height: number;
  color: readonly [number, number, number];
}>;
export type ApplianceFlexMesh = Readonly<{
  name: string;
  dim: 2 | 3;
  vertexCount: number;
  vertices: readonly number[];
  faces: readonly number[];
}>;
export type ApplianceSample = Readonly<{
  timeSeconds: number;
  contents: ApplianceContents;
  bodies: ReadonlyMap<string, AppliancePose>;
  telemetryText: string;
  displays: readonly ApplianceDisplay[];
  flexMeshes: readonly ApplianceFlexMesh[];
}>;
export type ApplianceResult = Readonly<{
  appliance: ApplianceName;
  runId: string;
  attemptId: string;
  outcome:
    | Readonly<{ kind: "completed" }>
    | Readonly<{ kind: "rejected"; action: number; message: string }>;
  samples: readonly ApplianceSample[];
  continuation: ApplianceContinuation;
  transferred: readonly ApplianceBatch[];
  file: string;
}>;

// MuJoCo's native integration state stays opaque to scheduling code. Rust checks
// its model, build identity and array dimensions when it restores this file.
export class ApplianceContinuation {
  // Explicit fields keep this file loadable by Node's type stripping.
  readonly appliance: ApplianceName;
  private readonly file: string;
  private constructor(appliance: ApplianceName, file: string) {
    this.appliance = appliance;
    this.file = file;
  }
  static fromRecording(
    raw: unknown,
    appliance: ApplianceName,
  ): ApplianceContinuation {
    // The engine seals the checkpoint in an envelope; a retained bundle
    // before Refactor 16 step 6D wrote the checkpoint alone.
    const body = checkpointBody(raw);
    if (
      body === null ||
      body.schema_version !== 1 ||
      body.appliance !== appliance ||
      !isRecord(body.execution) ||
      body.execution.backend !== "browser" ||
      typeof body.model_hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(body.model_hash) ||
      !Array.isArray(body.state) ||
      body.state.length > 100_000 ||
      !body.state.every(finite) ||
      !isRecord(body.parameters) ||
      !isRecord(body.controller)
    ) {
      throw new Error("The appliance continuation is invalid.");
    }
    parseContents(body.contents);
    return new ApplianceContinuation(appliance, JSON.stringify(raw));
  }
  request(
    runId: string,
    attemptId: string,
    actions: readonly ApplianceAction[],
  ): ApplianceRequest {
    return requestFile(
      this.appliance,
      runId,
      attemptId,
      { kind: "continue", checkpoint: JSON.parse(this.file) },
      actions,
    );
  }
}
export function freshApplianceRequest(
  appliance: ApplianceName,
  runId: string,
  attemptId: string,
  contents: ApplianceContents,
  actions: readonly ApplianceAction[],
): ApplianceRequest {
  return requestFile(
    appliance,
    runId,
    attemptId,
    { kind: "fresh", appliance, contents },
    actions,
  );
}
function requestFile(
  appliance: ApplianceName,
  runId: string,
  attemptId: string,
  initial: unknown,
  actions: readonly ApplianceAction[],
): ApplianceRequest {
  if (
    !/^[a-zA-Z0-9-]{1,128}$/u.test(runId) ||
    !/^[a-zA-Z0-9-]{1,128}$/u.test(attemptId)
  )
    throw new Error("Supply a valid run and attempt identity.");
  if (actions.length < 1 || actions.length > 256)
    throw new Error("Use 1–256 appliance actions.");
  const file = JSON.stringify({
    schema_version: 1,
    run_id: runId,
    attempt_id: attemptId,
    initial,
    actions,
  });
  if (new TextEncoder().encode(file).length > 16 * 1024 * 1024)
    throw new Error("The appliance request exceeds 16 MiB.");
  return Object.freeze({ appliance, runId, attemptId, file });
}
export function parseApplianceResult(
  file: string,
  request: ApplianceRequest,
): ApplianceResult {
  if (new TextEncoder().encode(file).length > 16 * 1024 * 1024)
    throw new Error("The appliance result exceeds 16 MiB.");
  const raw: unknown = JSON.parse(file);
  if (
    !isRecord(raw) ||
    raw.kind !== "bakery-appliance-recording" ||
    raw.schema_version !== 1 ||
    raw.run_id !== request.runId ||
    raw.attempt_id !== request.attemptId ||
    raw.appliance !== request.appliance ||
    !isRecord(raw.execution) ||
    raw.execution.backend !== "browser" ||
    !isRecord(raw.outcome) ||
    !Array.isArray(raw.samples) ||
    raw.samples.length < 1 ||
    raw.samples.length > 6002
  ) {
    throw new Error("The appliance result does not match this browser job.");
  }
  const outcome = parseOutcome(raw.outcome);
  validateActionEvidence(raw.events, request, outcome);
  if (!Array.isArray(raw.transferred))
    throw new Error("Invalid outgoing batches.");
  const transferred = raw.transferred.map(parseTransferred);
  const samples = raw.samples.map(parseApplianceSample);
  let previous = -1;
  for (const sample of samples) {
    if (sample.timeSeconds <= previous)
      throw new Error("Appliance samples must increase in time.");
    previous = sample.timeSeconds;
  }
  return Object.freeze({
    appliance: request.appliance,
    runId: request.runId,
    attemptId: request.attemptId,
    outcome,
    transferred: Object.freeze(transferred),
    samples: Object.freeze(samples),
    continuation: ApplianceContinuation.fromRecording(
      raw.continuation,
      request.appliance,
    ),
    file,
  });
}
function parseOutcome(
  raw: Record<string, unknown>,
): ApplianceResult["outcome"] {
  if (raw.kind === "completed") return { kind: "completed" };
  if (
    raw.kind === "rejected" &&
    typeof raw.action === "number" &&
    Number.isSafeInteger(raw.action) &&
    raw.action >= 0 &&
    typeof raw.message === "string"
  )
    return { kind: "rejected", action: raw.action, message: raw.message };
  throw new Error("Invalid appliance outcome.");
}
export function parseApplianceSample(raw: unknown): ApplianceSample {
  if (
    !isRecord(raw) ||
    !finite(raw.time_s) ||
    raw.time_s < 0 ||
    !isRecord(raw.bodies) ||
    !isRecord(raw.controller)
  )
    throw new Error("Invalid appliance sample.");
  const bodies = new Map<string, AppliancePose>();
  for (const [name, pose] of Object.entries(raw.bodies)) {
    if (!Array.isArray(pose) || pose.length !== 7 || !pose.every(finite))
      throw new Error("Invalid appliance body pose.");
    bodies.set(name, [
      number(pose[0]),
      number(pose[1]),
      number(pose[2]),
      number(pose[3]),
      number(pose[4]),
      number(pose[5]),
      number(pose[6]),
    ]);
  }
  return Object.freeze({
    timeSeconds: raw.time_s,
    contents: parseContents(raw.contents),
    bodies,
    telemetryText: JSON.stringify(raw.controller),
    displays: parseDisplays(raw.displays),
    flexMeshes: parseFlexMeshes(raw.flex_meshes),
  });
}
export function parseContents(raw: unknown): ApplianceContents {
  if (!isRecord(raw)) throw new Error("Invalid appliance contents.");
  if (raw.kind === "empty") return { kind: "empty" };
  if (raw.kind !== "loaded" || !isRecord(raw.batch))
    throw new Error("Invalid appliance batch.");
  const batch = raw.batch;
  if (
    typeof batch.identity !== "string" ||
    batch.identity.length < 1 ||
    batch.identity.length > 128 ||
    !finite(batch.mass_kg) ||
    batch.mass_kg <= 0 ||
    !finite(batch.temperature_c) ||
    batch.temperature_c < -20 ||
    batch.temperature_c > 300 ||
    !finite(batch.specific_heat) ||
    batch.specific_heat <= 0 ||
    !finite(batch.density_kg_l) ||
    batch.density_kg_l <= 0 ||
    !finite(batch.resistance) ||
    batch.resistance < 0 ||
    batch.resistance > 100
  )
    throw new Error("Invalid appliance batch properties.");
  return {
    kind: "loaded",
    batch: {
      identity: batch.identity,
      mass_kg: batch.mass_kg,
      temperature_c: batch.temperature_c,
      specific_heat: batch.specific_heat,
      density_kg_l: batch.density_kg_l,
      resistance: batch.resistance,
    },
  };
}
function finite(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

export function parseApplianceRequestEnvelope(raw: unknown): ApplianceRequest {
  if (
    !isRecord(raw) ||
    typeof raw.file !== "string" ||
    typeof raw.runId !== "string" ||
    typeof raw.attemptId !== "string" ||
    new TextEncoder().encode(raw.file).length > 16 * 1024 * 1024
  )
    throw new Error("Invalid appliance request envelope.");
  const appliance = parseName(raw.appliance);
  if (
    !/^[a-zA-Z0-9-]{1,128}$/u.test(raw.runId) ||
    !/^[a-zA-Z0-9-]{1,128}$/u.test(raw.attemptId)
  )
    throw new Error("Invalid appliance job identity.");
  return {
    appliance,
    runId: raw.runId,
    attemptId: raw.attemptId,
    file: raw.file,
  };
}
// The cases are generated from assets/bakery-mujoco/appliances.json.
function parseName(raw: unknown): ApplianceName {
  switch (raw) {
    case "la-marzocco-linea-classic-s-2g":
    case "victoria-arduino-eagle-one-2g":
    case "victoria-arduino-e1-prima":
    case "maruzen-mih-02c":
    case "vollrath-59500p":
    case "panasonic-kz-ck1402":
    case "rinnai-rsb-150pj":
    case "hoshizaki-rt-120snj":
    case "maruzen-mbco-5e":
    case "aicoh-ms-30":
    case "hobart-hl200":
    case "vitamix-quiet-one":
    case "waring-wsg60":
    case "severin-sm-3587":
    case "ohaus-ranger-3000":
    case "winterhalter-uc-l":
    case "option-o-lagom-casa":
    case "timemore-bricks-01s":
    case "fellow-opus-2":
    case "miicoffee-df64-gen2":
    case "hoshizaki-im-35p":
    case "pastry-bench":
      return raw;
    default:
      throw new Error("Unknown appliance.");
  }
}

function number(raw: unknown): number {
  if (!finite(raw)) throw new Error("Expected a finite number.");
  return raw;
}

function parseTransferred(raw: unknown): ApplianceBatch {
  const contents = parseContents({ kind: "loaded", batch: raw });
  if (contents.kind !== "loaded") throw new Error("Missing outgoing batch.");
  return contents.batch;
}

function validateActionEvidence(
  raw: unknown,
  request: ApplianceRequest,
  outcome: ApplianceResult["outcome"],
): void {
  const input: unknown = JSON.parse(request.file);
  if (!isRecord(input) || !Array.isArray(input.actions) || !Array.isArray(raw))
    throw new Error("Missing requested action evidence.");
  const count =
    outcome.kind === "completed" ? input.actions.length : outcome.action + 1;
  if (count > input.actions.length || raw.length !== count)
    throw new Error("Incomplete action evidence.");
  for (let index = 0; index < count; index++) {
    const event: unknown = raw[index];
    const kind =
      outcome.kind === "rejected" && index === outcome.action
        ? "rejected"
        : "accepted";
    if (
      !isRecord(event) ||
      event.index !== index ||
      event.kind !== kind ||
      canonicalJson(event.action) !== canonicalJson(input.actions[index])
    )
      throw new Error("The recording executed different actions.");
  }
}

function parseDisplays(raw: unknown): readonly ApplianceDisplay[] {
  if (!Array.isArray(raw) || raw.length > 8)
    throw new Error("Invalid appliance displays.");
  return raw.map(parseDisplay);
}
function parseDisplay(raw: unknown): ApplianceDisplay {
  if (
    !isRecord(raw) ||
    typeof raw.name !== "string" ||
    raw.name.length > 40 ||
    typeof raw.lamp !== "boolean" ||
    typeof raw.text !== "string" ||
    raw.text.length > 16 ||
    !Array.isArray(raw.pose) ||
    raw.pose.length !== 7 ||
    !raw.pose.every(finite) ||
    !finite(raw.width) ||
    raw.width <= 0 ||
    raw.width > 1 ||
    !finite(raw.height) ||
    raw.height <= 0 ||
    raw.height > 1 ||
    !Array.isArray(raw.color) ||
    raw.color.length !== 3 ||
    !raw.color.every(finite)
  )
    throw new Error("Invalid appliance display.");
  return {
    name: raw.name,
    text: raw.text,
    lamp: raw.lamp,
    pose: [
      number(raw.pose[0]),
      number(raw.pose[1]),
      number(raw.pose[2]),
      number(raw.pose[3]),
      number(raw.pose[4]),
      number(raw.pose[5]),
      number(raw.pose[6]),
    ],
    width: raw.width,
    height: raw.height,
    color: [number(raw.color[0]), number(raw.color[1]), number(raw.color[2])],
  };
}

function parseFlexMeshes(raw: unknown): readonly ApplianceFlexMesh[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > 8)
    throw new Error("Invalid appliance flex meshes.");
  return Object.freeze(raw.map(parseFlexMesh));
}

function parseFlexMesh(raw: unknown): ApplianceFlexMesh {
  if (
    !isRecord(raw) ||
    typeof raw.name !== "string" ||
    raw.name.length < 1 ||
    raw.name.length > 64 ||
    (raw.dim !== 2 && raw.dim !== 3) ||
    typeof raw.vertex_count !== "number" ||
    !Number.isSafeInteger(raw.vertex_count) ||
    raw.vertex_count < 3 ||
    raw.vertex_count > 4096 ||
    !Array.isArray(raw.vertices) ||
    raw.vertices.length !== raw.vertex_count * 3 ||
    !raw.vertices.every(finite) ||
    !Array.isArray(raw.faces) ||
    raw.faces.length < 3 ||
    raw.faces.length % 3 !== 0 ||
    raw.faces.length > 24576
  )
    throw new Error("Invalid appliance flex mesh.");
  const vertexCount = raw.vertex_count;
  const faces: number[] = [];
  for (const index of raw.faces) {
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= vertexCount
    )
      throw new Error("Invalid appliance flex face index.");
    faces.push(index);
  }
  return Object.freeze({
    name: raw.name,
    dim: raw.dim,
    vertexCount,
    vertices: Object.freeze(raw.vertices.map(number)),
    faces: Object.freeze(faces),
  });
}
