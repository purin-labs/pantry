import type { Settings } from "@purin-labs/bakery-model/bakery";
import {
  parsePhysicsCyclePlan,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  acceptProductionRecording,
  bindProductionSuccessor,
  compileRehearsalWorkcells,
  parseRehearsalWorkcells,
  type ContinuationSkill,
  type ProductionWorkcells,
  type ProductionWorkcellsResult,
  type RehearsalTray,
} from "../recipes/bakery/production-workcells.ts";
import { parseNativeContinuation } from "../recipes/bakery/native-continuation.ts";
import {
  parseWorkcellExperiment,
  type WorkcellExperiment,
} from "../recipes/bakery/workcell-experiment.ts";
import {
  compileCycleInput,
  compileNativeCycleInput,
  compileRackCycleInput,
  compileWorkcellInput,
  NATIVE_CHAIN,
  type WorkcellInput,
} from "../recipes/bakery/workcell-input.ts";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord, isString } from "@purin-labs/std";

// Earlier rehearsal files convert at the import boundary. Evidence replays
// through the same acceptance and binding as a live run. Anything the one
// engine does not model is listed; free-form tasks and local faults make the
// result read-only until the operator starts a new rehearsal from it.
export type RehearsalConversion = Readonly<{
  plan: ProductionWorkcells;
  notes: readonly string[];
  readOnly: readonly string[];
}>;
type RehearsalConversionResult =
  | Readonly<{
      kind: "ready";
      conversion: RehearsalConversion;
      message?: never;
    }>
  | Readonly<{ kind: "rejected"; message: string; conversion?: never }>;

const LETTERS = [..."ABCDEFGHIJKLMNOP"];

export async function openRehearsalDocument(
  text: string,
  settings: Settings,
): Promise<RehearsalConversionResult> {
  try {
    const raw: unknown = JSON.parse(text);
    const kind =
      typeof raw === "object" && raw !== null && "kind" in raw
        ? raw.kind
        : null;
    switch (kind) {
      case "bakery-rehearsal-run": {
        const parsed = await parseRehearsalWorkcells(text);
        return parsed.kind === "rejected"
          ? parsed
          : {
              kind: "ready",
              conversion: { plan: parsed.plan, notes: [], readOnly: [] },
            };
      }
      case "bakery-orchestration-run":
        return await convertTrayRun(text, settings);
      case "bakery-workcell-experiment":
        return await convertExperiment(text, settings);
      default:
        return rejected("Choose a Kitchen rehearsal file.");
    }
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : "Unable to open the rehearsal.",
    );
  }
}

// An operation as a previous multi-tray file saved it (versions 1–4).
type SavedOperation = {
  id: string;
  trayId: string;
  name: string;
  earliestStart: number;
  predecessorId: string | null;
  skill: ContinuationSkill | null;
  experiment: WorkcellExperiment | null;
  handoff: string | null;
};

async function convertTrayRun(
  text: string,
  settings: Settings,
): Promise<RehearsalConversionResult> {
  const saved = readTrayRun(text);
  if (saved.kind === "rejected") return saved;
  const { trays: names, operations } = saved;
  // Each reset operation starts a chain; a continuation joins its predecessor's.
  const chains: SavedOperation[][] = [];
  for (const operation of operations) {
    if (operation.predecessorId === null) {
      chains.push([operation]);
      continue;
    }
    const chain = chains.find(endsWith.bind(null, operation.predecessorId));
    if (chain === undefined)
      return rejected("A saved continuation has no predecessor in this run.");
    chain.push(operation);
  }
  if (chains.length > LETTERS.length)
    return rejected("A rehearsal supports up to sixteen trays.");
  const notes: string[] = [];
  const trays: RehearsalTray[] = [];
  for (const [index, chain] of chains.entries()) {
    const root = chain[0];
    if (root === undefined || root.experiment === null)
      return rejected("Each saved tray needs its first request.");
    const batchId = LETTERS[index] ?? "A";
    notes.push(
      `${names.get(root.trayId) ?? root.trayId} · ${root.name} → Tray ${batchId}`,
    );
    const successors: RehearsalTray["successors"][number][] = [];
    for (const operation of chain.slice(1))
      successors.push({
        skill: operationSkill(operation),
        earliestStartSeconds: Math.round(operation.earliestStart),
      });
    trays.push({
      batchId,
      workerId: "human-1",
      dependsOn: [],
      earliestStartSeconds: Math.round(root.earliestStart),
      input: rootInput(root.experiment.input),
      successors,
    });
  }
  const compiled = await compileRehearsalWorkcells(settings, trays);
  if (compiled.kind === "rejected") return compiled;
  let plan = compiled.plan;
  for (const [index, chain] of chains.entries()) {
    const root = `batch:${LETTERS[index]}:native:1`;
    for (const [step, operation] of chain.entries()) {
      const experiment = operation.experiment;
      if (experiment === null || experiment.kind !== "recorded") break;
      const id = step === 0 ? root : `${root}:${step + 1}`;
      if (experiment.mode === "cycle-loading") {
        notes.push(
          `${operation.name}: loading-only evidence was not carried forward. Run the cycle again.`,
        );
        break;
      }
      const successor = step + 1 < chain.length;
      const accepted = await acceptAndBind(
        plan,
        id,
        experiment.recording,
        successor && operation.handoff !== null
          ? parseNativeContinuation(operation.handoff)
          : null,
      );
      if (accepted.kind === "rejected") return accepted;
      plan = accepted.plan;
    }
  }
  notes.push(
    "Converted from the previous engine. Staging and clearance now use production handling times.",
  );
  return { kind: "ready", conversion: { plan, notes, readOnly: [] } };
}

// Reads the saved operations of a previous multi-tray file without the engine
// that wrote it. Versions 2 and 3 keep a handoff on its successor's start;
// version 4 keeps it on the operation that produced it.
function readTrayRun(text: string):
  | Readonly<{
      kind: "ready";
      trays: ReadonlyMap<string, string>;
      operations: readonly SavedOperation[];
      message?: never;
    }>
  | Readonly<{ kind: "rejected"; message: string }> {
  const raw = record(JSON.parse(text));
  const version = raw.schemaVersion;
  if (
    raw.kind !== "bakery-orchestration-run" ||
    (version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
    !Array.isArray(raw.trays) ||
    !Array.isArray(raw.operations) ||
    raw.trays.length > 16 ||
    raw.operations.length > 16
  )
    return rejected("Choose a supported multi-tray run.");
  const trays = new Map<string, string>();
  for (const value of raw.trays) {
    const tray = record(value);
    if (typeof tray.id !== "string" || typeof tray.name !== "string")
      return rejected("Tray IDs and names must be valid.");
    trays.set(tray.id, tray.name);
  }
  const operations: SavedOperation[] = [];
  for (const value of raw.operations) {
    const operation = record(value);
    if (
      typeof operation.id !== "string" ||
      typeof operation.trayId !== "string" ||
      !trays.has(operation.trayId) ||
      typeof operation.name !== "string" ||
      typeof operation.earliestStart !== "number"
    )
      return rejected(
        "Each operation needs a tray, name and start constraint.",
      );
    const start = version === 1 ? { kind: "reset" } : record(operation.start);
    const predecessorId =
      start.kind === "continuation" && typeof start.predecessorId === "string"
        ? start.predecessorId
        : null;
    if (start.kind !== "reset" && predecessorId === null)
      return rejected("Choose a valid staging or continuation boundary.");
    const saved: SavedOperation = {
      id: operation.id,
      trayId: operation.trayId,
      name: operation.name,
      earliestStart: operation.earliestStart,
      predecessorId,
      skill: null,
      experiment: null,
      handoff:
        version === 4 && typeof operation.handoff === "string"
          ? operation.handoff
          : null,
    };
    if (operation.kind === "awaiting-handoff") {
      if (version < 3 || predecessorId === null)
        return rejected("A planned successor needs its predecessor.");
      saved.skill = savedSkill(start.skill);
    } else {
      const experiment = parseWorkcellExperiment(
        JSON.stringify(operation.experiment),
      );
      if (experiment.kind === "rejected") return experiment;
      saved.experiment = experiment.experiment;
    }
    // Earlier versions saved the predecessor's handoff with its successor.
    if (predecessorId !== null && typeof start.file === "string") {
      const predecessor = operations.find(hasId.bind(null, predecessorId));
      if (predecessor !== undefined) predecessor.handoff = start.file;
    }
    operations.push(saved);
  }
  return { kind: "ready", trays, operations };
}

async function convertExperiment(
  text: string,
  settings: Settings,
): Promise<RehearsalConversionResult> {
  const document = record(JSON.parse(text));
  const saved = isRecord(document.input) ? document.input : null;
  const workflow =
    document.schemaVersion === 1 || saved === null
      ? null
      : legacyWorkflow(saved.chain);
  // The request and its evidence parse as a current file. A robot task that
  // never dispatched keeps no evidence.
  const parsed = parseWorkcellExperiment(
    JSON.stringify({
      ...document,
      input:
        workflow === null || saved === null
          ? document.input
          : { ...saved, chain: NATIVE_CHAIN },
      evidence: workflow?.blocked === true ? null : document.evidence,
      ...(document.schemaVersion === 3 ? { presentation: {} } : {}),
    }),
  );
  if (parsed.kind === "rejected") return parsed;
  const experiment = parsed.experiment;
  const input = experiment.input;
  const readOnly: string[] = [];
  if (workflow !== null && workflow.freeForm.length > 0)
    readOnly.push(
      `Free-form tasks are retired: ${workflow.freeForm.join(", ")}.`,
    );
  if (workflow?.production === true)
    readOnly.push(
      "Its financier batch now runs as a production scenario in Multi-batch + robot.",
    );
  if (workflow?.faults === true)
    readOnly.push(
      "Its local outages, injected failures and assumed recoveries are not carried forward.",
    );
  if (workflow?.blocked === true)
    readOnly.push("Its robot task was blocked by a failed local task.");
  const compiled = await compileRehearsalWorkcells(settings, [
    {
      batchId: "A",
      workerId: "human-1",
      dependsOn: [],
      earliestStartSeconds: Math.round(
        Math.max(input.requestedDispatchTime, workflow?.earliestStart ?? 0),
      ),
      input: rootInput(input),
      successors: [],
    },
  ]);
  if (compiled.kind === "rejected") return compiled;
  let plan = compiled.plan;
  const notes: string[] = [];
  if (experiment.kind === "recorded") {
    if (
      experiment.recording.kind === "bakery-physics-recording" &&
      input.kind !== "transfer"
    ) {
      notes.push(
        "Loading-only evidence for this cycle was not carried forward. Run the cycle again.",
      );
    } else {
      const accepted = acceptProductionRecording(
        plan,
        plan.fingerprint,
        "batch:A:native:1",
        experiment.recording,
      );
      if (accepted.kind === "rejected") return accepted;
      plan = accepted.plan;
    }
  }
  notes.push("Converted from a single rehearsal as Tray A.");
  return { kind: "ready", conversion: { plan, notes, readOnly } };
}

// Earlier single rehearsals saved a workflow around their robot task: manual
// and equipment tasks, prerequisites, faults and a financier batch. Only the
// robot task carries forward; the rest is listed and the tray opens
// read-only.
type LegacyWorkflow = Readonly<{
  freeForm: readonly string[];
  production: boolean;
  faults: boolean;
  // A prerequisite of the robot task failed, so it never dispatched.
  blocked: boolean;
  earliestStart: number;
}>;
type LegacyTask = Readonly<{
  id: string;
  name: string;
  kind: string;
  dependencies: readonly string[];
  earliestStart: number;
}>;

function legacyWorkflow(value: unknown): LegacyWorkflow {
  const chain = record(value);
  if (!Array.isArray(chain.tasks))
    throw new Error("This saved run's workflow is invalid.");
  const tasks = chain.tasks.map(legacyTask);
  const native = tasks.filter(isNativeTask);
  const robot = native[0];
  if (robot === undefined || native.length > 1)
    throw new Error("A saved single rehearsal needs exactly one robot task.");
  const failed = new Set<string>();
  for (const failure of legacyList(chain.failures)) {
    const bakeryTaskId = record(failure).bakeryTaskId;
    if (typeof bakeryTaskId === "string") failed.add(bakeryTaskId);
  }
  return {
    freeForm: tasks.filter(isFreeForm).map(taskName),
    production: chain.production !== undefined && chain.production !== null,
    faults:
      legacyList(chain.unavailable).length > 0 ||
      failed.size > 0 ||
      legacyList(chain.recoveries).length > 0,
    blocked: dependsOnFailure(robot, tasks, failed, new Set()),
    earliestStart: robot.earliestStart,
  };
}
function legacyTask(value: unknown): LegacyTask {
  const task = record(value);
  if (
    typeof task.id !== "string" ||
    typeof task.name !== "string" ||
    typeof task.kind !== "string" ||
    !Array.isArray(task.dependencies) ||
    !task.dependencies.every(isString) ||
    typeof task.earliestStart !== "number" ||
    !(task.earliestStart >= 0 && task.earliestStart <= 43200)
  )
    throw new Error("This saved run's workflow is invalid.");
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    dependencies: task.dependencies,
    earliestStart: task.earliestStart,
  };
}
function legacyList(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("This saved run's workflow is invalid.");
  return value;
}
// A failed task never satisfies the tasks that depend on it, directly or not.
function dependsOnFailure(
  task: LegacyTask,
  tasks: readonly LegacyTask[],
  failed: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  for (const id of task.dependencies) {
    if (failed.has(id)) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = tasks.find(hasBakeryTaskId.bind(null, id));
    if (
      dependency !== undefined &&
      dependsOnFailure(dependency, tasks, failed, visited)
    )
      return true;
  }
  return false;
}

async function acceptAndBind(
  plan: ProductionWorkcells,
  id: string,
  recording: PhysicsReplay,
  handoff: Parameters<typeof acceptProductionRecording>[4],
): Promise<ProductionWorkcellsResult> {
  const accepted = acceptProductionRecording(
    plan,
    plan.fingerprint,
    id,
    recording,
    handoff ?? null,
  );
  if (accepted.kind === "rejected") return accepted;
  return bindProductionSuccessor(accepted.plan, id);
}

// A rehearsal tray starts its first skill at dispatch zero; an authored
// dispatch delay becomes the tray's earliest start.
function rootInput(input: WorkcellInput): WorkcellInput {
  let compiled;
  switch (input.kind) {
    case "transfer":
      compiled = compileWorkcellInput(input.request, "0", "cold-cell-1");
      break;
    case "native-cycle":
      compiled = compileNativeCycleInput(input.request, "0", "cold-cell-1");
      break;
    case "oven-cycle": {
      const plan = parsePhysicsCyclePlan(
        JSON.stringify({
          request: input.request,
          returnRequest: input.returnRequest,
          handoffDigest: input.handoffDigest,
        }),
      );
      if (plan.kind === "rejected") throw new Error(plan.message);
      compiled = compileCycleInput(plan.plan, "0", "cold-cell-1");
      break;
    }
    case "rack-cycle":
      compiled = compileRackCycleInput(input.rackPlan, "0", "cold-cell-1");
      break;
  }
  if (compiled.kind === "invalid") throw new Error(compiled.message);
  return compiled.input;
}

function operationSkill(operation: SavedOperation): ContinuationSkill {
  if (operation.skill !== null) return operation.skill;
  const input = operation.experiment?.input;
  if (input?.kind === "oven-cycle") return { kind: "unload" };
  if (input?.kind === "rack-cycle")
    return {
      kind: "rack",
      rackCase: input.rackPlan.rackRequest.case === "slip" ? "slip" : "nominal",
    };
  throw new Error("A saved continuation must be retrieval or racking.");
}
function savedSkill(value: unknown): ContinuationSkill {
  const skill = record(value);
  if (skill.kind === "unload") return { kind: "unload" };
  if (
    skill.kind === "rack" &&
    (skill.rackCase === "nominal" || skill.rackCase === "slip")
  )
    return { kind: "rack", rackCase: skill.rackCase };
  throw new Error("Choose retrieval or a supported rack transfer.");
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a valid multi-tray run.");
  return Object.fromEntries(Object.entries(value));
}
function hasId(id: string, operation: SavedOperation): boolean {
  return operation.id === id;
}
function endsWith(id: string, chain: readonly SavedOperation[]): boolean {
  return chain.at(-1)?.id === id;
}
function isFreeForm(task: LegacyTask): boolean {
  return task.kind !== "native";
}
function isNativeTask(task: LegacyTask): boolean {
  return task.kind === "native";
}
function taskName(task: LegacyTask): string {
  return task.name;
}
function hasBakeryTaskId(id: string, task: LegacyTask): boolean {
  return task.id === id;
}
function rejected(
  message: string,
): Variant<RehearsalConversionResult, "rejected"> {
  return { kind: "rejected", message };
}
