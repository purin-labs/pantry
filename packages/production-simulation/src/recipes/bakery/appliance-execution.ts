import {
  canonicalJson,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
} from "@purin-labs/std";
import { compareCompletedTasks } from "./completed-task-order.ts";
import { strFromU8, strToU8 } from "fflate";
import { exchangeNow, type CellModule } from "../../native/wasm-transport.ts";
import {
  freshApplianceRequest,
  parseApplianceResult,
  type ApplianceAction,
  type ApplianceBatch,
  type ApplianceContents,
  type ApplianceContinuation,
  type ApplianceName,
  type ApplianceRequest,
  type ApplianceResult,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import { checkpointBody } from "@purin-labs/bakery-model/bakery-checkpoint";
import type { CompiledScenario, TaskDefinition } from "../../scenario.ts";
import type { RunState } from "../../state.ts";
import {
  computeContinuousWaveCarrierReturnSummary,
  type ContinuousWaveCarrierReturnSummary,
} from "./carrier-pool-turnaround.ts";
import {
  buildPastryUnflouredFaultActions,
  buildPastryUnflouredRestoreActions,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
} from "./pastry-bench-execution.ts";
import {
  computeCoupledBatchPhysics,
  computeFacilityUtilityLoadSummary,
  computeQualityGateMassBalanceSummary,
  evaluatePendingInspectionGate,
  resolveUpstreamThermalHandoff,
  type BatchThermalState,
  type CoupledBatchPhysicsMetrics,
  type CoupledInspectionDecision,
  type FacilityUtilityLoadSummary,
  type QualityGateMassBalanceSummary,
} from "./appliance-telemetry.ts";

export {
  evaluatePendingInspectionGate,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
};

export type ApplianceCategory =
  | "weigh"
  | "hob"
  | "mixer"
  | "grinder"
  | "blender"
  | "milk-frother"
  | "espresso"
  | "oven"
  | "chiller"
  | "dishwasher"
  | "pastry-bench";

/**
 * Canonical appliance task kind shared by the recipe data rows and the
 * Plan 84 workflow canvas compiler.
 */
export type ApplianceTaskKind =
  | "weigh"
  | "hob-power"
  | "hob-temperature"
  | "planetary-mix"
  | "grind"
  | "blend"
  | "heated-frother"
  | "espresso"
  | "oven-preheat"
  | "oven-bake"
  | "chiller"
  | "dishwasher"
  | "pastry-press"
  | "pastry-sheet"
  | "pastry-drape";

export type ApplianceWorkflowMatcher = Readonly<{
  exact?: readonly string[];
  prefixes?: readonly string[];
  suffixes?: readonly string[];
}>;

export type ApplianceKeyMatcher = Readonly<{
  exact?: readonly string[];
  prefixes?: readonly string[];
  /** Strips a leading `tray-N.` prefix before matching and sets `taskKey` to the stripped key. */
  stripTrayPrefix?: boolean;
}>;

export type ApplianceBatchRowSpec = Readonly<{
  /** Suffix appended to `${instanceId}-` for batch identity; defaults to matched `taskKey`. */
  idSuffix?: string;
  /** Default mass in kg when the task definition has no mass or `massSource === "fixed"`. */
  massKg: number;
  /** `"definition"` reads task lot mass first (default); `"fixed"` always uses `massKg`. */
  massSource?: "definition" | "fixed";
  /** Divides definition mass by the count of lot outputs with this product id (e.g. pie trays). */
  divideMassByOutputProduct?: string;
  temperatureC: number;
  specificHeat: number;
  densityKgL: number;
  resistance: number;
}>;

export type ApplianceActionRowSpec =
  | Readonly<{ kind: "weigh" }>
  | Readonly<{
      kind: "hob-power";
      percent: number;
      durationSeconds: number;
      carryPreviousTempRange?: readonly [number, number];
    }>
  | Readonly<{
      kind: "hob-temperature";
      targetC: number;
      durationSeconds: number;
    }>
  | Readonly<{
      kind: "hob-temperature-from-key";
      fallbackTargetC: number;
      durationSeconds: number;
      defaultTempOffsetC: number;
      minDefaultTempC: number;
      carryMinTempC: number;
      carryMaxOffsetC: number;
    }>
  | Readonly<{
      kind: "planetary-mix";
      setting: 1 | 2 | 3 | 4;
      durationSeconds: number;
    }>
  | Readonly<{ kind: "grind"; durationSeconds: number }>
  | Readonly<{ kind: "blend"; percent: number; durationSeconds: number }>
  | Readonly<{ kind: "heated-frother"; targetC: number }>
  | Readonly<{ kind: "espresso"; durationSeconds: number }>
  | Readonly<{ kind: "oven-preheat"; targetC: number }>
  | Readonly<{ kind: "oven-bake"; targetC: number; durationSeconds: number }>
  | Readonly<{ kind: "chiller"; durationSeconds: number }>
  | Readonly<{ kind: "dishwasher"; durationSeconds: number }>
  | Readonly<{
      kind: "pastry-press";
      targetHeightMm: number;
      durationSeconds: number;
    }>
  | Readonly<{
      kind: "pastry-sheet";
      targetThicknessMm: number;
      durationSeconds: number;
    }>
  | Readonly<{
      kind: "pastry-drape";
      targetDepthMm: number;
      durationSeconds: number;
    }>;

/**
 * Pure data row mapping a recipe or canvas task kind to its MuJoCo appliance,
 * batch properties, and action sequence.
 */
export type ApplianceTaskRow = Readonly<{
  recipe: string;
  taskKind: ApplianceTaskKind;
  workflows: ApplianceWorkflowMatcher;
  keys: ApplianceKeyMatcher;
  category: ApplianceCategory;
  appliance: ApplianceName;
  /** Uses the `espressoAppliance` option (`linea` / `eagle-one`) when set. */
  useEspressoOption?: boolean;
  /** Label template supporting `{product}`, `{productLower}`, and `{key}`. */
  label: string;
  productSource?: "financier" | "pie";
  batch: ApplianceBatchRowSpec | null;
  action: ApplianceActionRowSpec;
}>;

export type ApplianceTaskContext = Readonly<{
  continuation: ApplianceContinuation | null;
  checkpoint: Record<string, unknown> | null;
  previousInstanceBatchTemperatureC: number | null;
}>;

export type ScheduledTaskDescriptor = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  definition: TaskDefinition | null;
}>;

export type RecipeApplianceTaskBinding = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  category: ApplianceCategory;
  appliance: ApplianceName;
  label: string;
  batch: ApplianceBatch | null;
  buildActions(context: ApplianceTaskContext): readonly ApplianceAction[];
}>;

/** The controller's Wasm module; an appliance run is one host command. */
type ApplianceWasmRuntime = CellModule;

/** Async runner backed by a browser ExecutionWorker or headless host. */
export type ApplianceAttemptRunner = Readonly<{
  runAttempt(
    request: ApplianceRequest,
    taskId: string,
    appliance: ApplianceName,
  ): Promise<ApplianceResult>;
}>;

type ApplianceWasmRuntimeSource =
  | ApplianceWasmRuntime
  | (() => Promise<ApplianceWasmRuntime> | ApplianceWasmRuntime)
  | ApplianceAttemptRunner;

type ApplianceFaultInjectionSpec = Readonly<{
  faultKind:
    | "mixer-guard-open"
    | "blender-lid-open"
    | "oven-door-open"
    | "dishwasher-door-open"
    | "pastry-bench-unfloured";
  description: string;
  buildFaultActions(
    binding: RecipeApplianceTaskBinding,
    context: ApplianceTaskContext,
  ): readonly ApplianceAction[];
  buildRestoreActions(
    binding: RecipeApplianceTaskBinding,
    faultCheckpoint: Record<string, unknown>,
  ): readonly ApplianceAction[];
}>;

type ExecutedApplianceFaultRestoreRecord = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  appliance: ApplianceName;
  category: ApplianceCategory;
  faultKind: ApplianceFaultInjectionSpec["faultKind"];
  description: string;
  priorCheckpointDigest: string | null;
  faultAttemptId: string;
  faultRejectedActionIndex: number;
  faultMessage: string;
  faultRecordingDigest: string;
  faultCheckpointDigest: string;
  faultControllerState: unknown;
  faultSampleCount: number;
  faultSimulatedSeconds: number;
  restoreAttemptId: string;
  resumedFromFaultCheckpointDigest: string;
  restoredRecordingDigest: string;
  restoredCheckpointDigest: string;
  restoredSampleCount: number;
  restoredSimulatedSeconds: number;
  transferredCount: number;
}>;

type LinkedCellId = "tea-pan-cell" | "espresso-cell" | "pour-over-cell";

type LinkedCellCascadeTransferRecord = Readonly<{
  cellId: LinkedCellId;
  transferTaskId: string;
  batchInstanceId: string;
  workflowId: string;
  taskKey: string;
  baselineStartSeconds: number;
  cascadedStartSeconds: number;
  delaySeconds: number;
  heldByAppliance: ApplianceName;
  heldByFaultKind: ApplianceFaultInjectionSpec["faultKind"];
  releasedByCheckpointDigest: string;
  status: "recovered";
}>;

type MultiBatchFaultCascadeRecord = Readonly<{
  faultTaskId: string;
  faultInstanceId: string;
  appliance: ApplianceName;
  faultKind: ApplianceFaultInjectionSpec["faultKind"];
  faultCheckpointDigest: string;
  restoredCheckpointDigest: string;
  faultSimulatedSeconds: number;
  restoredSimulatedSeconds: number;
  recoveryDelaySeconds: number;
  affectedBatches: readonly string[];
  affectedCells: readonly LinkedCellId[];
  shiftedTaskCount: number;
  linkedCellTransfers: readonly LinkedCellCascadeTransferRecord[];
}>;

export type ExecutedApplianceTaskRecord = Readonly<{
  index: number;
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  cascadeShiftedByUs?: number;
  cascadeHeldByFaultTaskIds?: readonly string[];
  category: ApplianceCategory;
  appliance: ApplianceName;
  label: string;
  resumedFromCheckpointDigest: string | null;
  request: ApplianceRequest;
  result: ApplianceResult;
  recordingDigest: string;
  checkpointDigest: string;
  sampleCount: number;
  simulatedSeconds: number;
  inputBatch: ApplianceBatch | null;
  transferred: readonly ApplianceBatch[];
  finalController: unknown;
  finalDisplays: readonly unknown[];
  coupledPhysics: CoupledBatchPhysicsMetrics;
  faultRestore?: ExecutedApplianceFaultRestoreRecord;
}>;

/** Risk summary for a task whose appliance physics check failed or rejected. */
export type ApplianceTaskRisk = Readonly<{
  taskId: string;
  appliance: ApplianceName;
  category: ApplianceCategory;
  gateKind: CoupledInspectionDecision["gateKind"] | "appliance-rejected";
  reason: string;
  measured: string | null;
  targetSpecRange: string | null;
}>;

export type RecipeApplianceExecutionReport = Readonly<{
  runId: string;
  taskCount: number;
  applianceCount: number;
  records: readonly ExecutedApplianceTaskRecord[];
  faultRestores: readonly ExecutedApplianceFaultRestoreRecord[];
  faultCascades: readonly MultiBatchFaultCascadeRecord[];
  facilityUtilities: FacilityUtilityLoadSummary;
  massBalance: QualityGateMassBalanceSummary;
  carrierReturnSummary: ContinuousWaveCarrierReturnSummary;
  continuations: ReadonlyMap<ApplianceName, ApplianceContinuation>;
  checkpointDigests: Readonly<Record<string, string>>;
}>;

type RecipeApplianceExecutionOptions = Readonly<{
  runId?: string;
  initialContinuations?: ReadonlyMap<ApplianceName, ApplianceContinuation>;
  faultInjections?: ReadonlyMap<string, ApplianceFaultInjectionSpec>;
  scheduledTasks?: readonly ScheduledTaskDescriptor[];
  /** Keep executing remaining checks when an appliance rejects an action. */
  continueOnRejection?: boolean;
  /** Optional cancellation token checked between appliance tasks. */
  signal?: Readonly<{ aborted: boolean }>;
  /** Optional progress callback invoked after each task completes. */
  onProgress?: (
    completed: number,
    total: number,
    record: ExecutedApplianceTaskRecord,
  ) => void;
}>;

/**
 * Classifies one executed appliance task record as at risk if its MuJoCo
 * controller rejected an action or its coupled physics quality gate rejected.
 * Does not fail the schedule task (Refactor 16 D3).
 */
export function applianceTaskRisk(
  record: ExecutedApplianceTaskRecord,
): ApplianceTaskRisk | null {
  if (record.result.outcome.kind === "rejected") {
    return {
      taskId: record.taskId,
      appliance: record.appliance,
      category: record.category,
      gateKind: "appliance-rejected",
      reason: `Appliance rejected action ${record.result.outcome.action}: ${record.result.outcome.message}`,
      measured: null,
      targetSpecRange: null,
    };
  }
  const decision = record.coupledPhysics.inspectionDecision;
  if (decision.recommendedOutcome === "reject") {
    return {
      taskId: record.taskId,
      appliance: record.appliance,
      category: record.category,
      gateKind: decision.gateKind,
      reason: decision.rationale,
      measured: `${decision.measuredValue} ${decision.unit}`,
      targetSpecRange: decision.targetSpecRange,
    };
  }
  return null;
}

/** Collects every task marked at risk by failed appliance physics checks. */
export function atRiskTasksFromApplianceReport(
  report: RecipeApplianceExecutionReport,
): ReadonlyMap<string, ApplianceTaskRisk> {
  const risks = new Map<string, ApplianceTaskRisk>();
  for (const record of report.records) {
    const risk = applianceTaskRisk(record);
    if (risk !== null) risks.set(record.taskId, risk);
  }
  return risks;
}

function sanitizeAttemptId(raw: string, index: number): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const prefix = `step-${index + 1}-`;
  const maxBody = 120 - prefix.length;
  const body = (cleaned.length > 0 ? cleaned : "task").slice(0, maxBody);
  return `${prefix}${body}`;
}

export function batchSpec(
  identity: string,
  massKg: number,
  temperatureC = 20,
  specificHeat = 3800,
  densityKgL = 1.03,
  resistance = 0.05,
): ApplianceBatch {
  const safeId = identity
    .replace(/[^a-zA-Z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return {
    identity: safeId.length > 0 ? safeId : "recipe-batch",
    mass_kg: Math.max(0.001, Number(massKg.toFixed(6))),
    temperature_c: Number(temperatureC.toFixed(3)),
    specific_heat: specificHeat,
    density_kg_l: densityKgL,
    resistance,
  };
}

export function taskMaterialMassKg(
  definition: TaskDefinition | null,
  fallbackKg: number,
): number {
  if (definition === null) return fallbackKg;
  let outputMg = 0;
  for (const out of definition.outputs) {
    if (out.kind === "lot" && out.quantity.unit === "milligram")
      outputMg += out.quantity.amount;
  }
  if (outputMg > 0) return outputMg / 1_000_000;
  let inputMg = 0;
  for (const inp of definition.inputs) {
    if (inp.quantity.unit === "milligram") inputMg += inp.quantity.amount;
  }
  if (inputMg > 0) return inputMg / 1_000_000;
  return fallbackKg;
}

export type ScheduledTaskSource =
  | RunState
  | CompiledScenario
  | Readonly<{
      definition: Readonly<{ scenario: CompiledScenario }>;
      instances: readonly Readonly<{ id: string; workflow: string }>[];
      tasks: readonly Readonly<Record<string, unknown>>[];
    }>;

export function extractScheduledTasks(
  source: ScheduledTaskSource,
): readonly ScheduledTaskDescriptor[] {
  if ("definition" in source && "tasks" in source && "instances" in source) {
    const scenario = source.definition.scenario;
    const workflowByInstance = new Map<string, string>();
    for (const instance of source.instances)
      workflowByInstance.set(instance.id, instance.workflow);
    const definitionMap = new Map<string, TaskDefinition>();
    for (const wf of scenario.workflows) {
      for (const td of wf.tasks) {
        definitionMap.set(`${wf.id}/${td.key}`, td);
      }
    }
    const completed: ScheduledTaskDescriptor[] = [];
    for (const rawTask of source.tasks) {
      if (!isRecord(rawTask) || rawTask.kind !== "completed") continue;
      const taskId = typeof rawTask.id === "string" ? rawTask.id : "";
      const startedAtUs =
        typeof rawTask.startedAt === "number" ? rawTask.startedAt : 0;
      const completedAtUs =
        typeof rawTask.completedAt === "number" ? rawTask.completedAt : 0;
      let instanceId: string | null = null;
      let taskKey: string | null = null;
      if ("subject" in rawTask && isRecord(rawTask.subject)) {
        if (
          rawTask.subject.kind === "workflow" &&
          typeof rawTask.subject.instance === "string" &&
          typeof rawTask.subject.key === "string"
        ) {
          instanceId = rawTask.subject.instance;
          taskKey = rawTask.subject.key;
        }
      } else if (
        "instance" in rawTask &&
        typeof rawTask.instance === "string" &&
        "definition" in rawTask &&
        typeof rawTask.definition === "string"
      ) {
        instanceId = rawTask.instance;
        taskKey = rawTask.definition;
      }
      if (instanceId === null || taskKey === null) continue;
      const workflowId = workflowByInstance.get(instanceId) ?? "workflow";
      completed.push({
        taskId,
        instanceId,
        workflowId,
        taskKey,
        startedAtUs,
        completedAtUs,
        definition: definitionMap.get(`${workflowId}/${taskKey}`) ?? null,
      });
    }
    completed.sort(compareCompletedTasks);
    return completed;
  }

  const scenario = source;
  const descriptors: ScheduledTaskDescriptor[] = [];
  let cursorUs = 0;
  for (const wf of scenario.workflows) {
    const arrivalSource = scenario.arrivals.find((a) => a.workflow === wf.id);
    const count =
      arrivalSource?.kind === "explicit"
        ? Math.max(1, arrivalSource.arrivals.length)
        : 1;
    const prefix = arrivalSource?.id ?? wf.id;
    for (let index = 0; index < count; index++) {
      const instanceId = `${prefix}#${index}`;
      for (const td of wf.tasks) {
        const startUs = cursorUs;
        cursorUs += 1_000_000;
        descriptors.push({
          taskId: `${instanceId}/${td.key}`,
          instanceId,
          workflowId: wf.id,
          taskKey: td.key,
          startedAtUs: startUs,
          completedAtUs: cursorUs,
          definition: td,
        });
      }
    }
  }
  return descriptors;
}

export function weighActions(
  batch: ApplianceBatch,
): readonly ApplianceAction[] {
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "start", program: { kind: "weigh" } },
    { kind: "advance", seconds: 3 },
    { kind: "require", state: "stable" },
    { kind: "remove-contents" },
  ];
}

export function hobPowerActions(
  batch: ApplianceBatch,
  percent: number,
  durationSeconds = 5,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    2,
    Math.min(20, Math.round(durationSeconds)),
  );
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "hob-power",
        percent: Math.max(10, Math.min(90, percent)),
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 1 },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function hobTemperatureActions(
  batch: ApplianceBatch,
  targetC: number,
  durationSeconds = 5,
): readonly ApplianceAction[] {
  const clampedTarget = Math.max(45, Math.min(90, targetC));
  const clampedDuration = Math.max(
    2,
    Math.min(20, Math.round(durationSeconds)),
  );
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "hob-temperature",
        target_c: clampedTarget,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 1 },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function planetaryMixActions(
  batch: ApplianceBatch,
  setting: 1 | 2 | 3 | 4 = 2,
  durationSeconds = 4,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    2,
    Math.min(10, Math.round(durationSeconds)),
  );
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "planetary",
        setting,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 4 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function grindActions(
  batch: ApplianceBatch,
  durationSeconds = 3,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(2, Math.min(8, Math.round(durationSeconds)));
  const highDragBatch: ApplianceBatch = {
    ...batch,
    resistance: Math.max(25, batch.resistance),
  };
  return [
    {
      kind: "set-contents",
      contents: { kind: "loaded", batch: highDragBatch },
    },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "grind",
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 3 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function blendActions(
  batch: ApplianceBatch,
  percent = 45,
  durationSeconds = 4,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    2,
    Math.min(10, Math.round(durationSeconds)),
  );
  const dampedBatch: ApplianceBatch = {
    ...batch,
    resistance: Math.max(2.5, batch.resistance),
  };
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch: dampedBatch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "blend",
        percent: Math.max(7, Math.min(100, Math.round(percent))),
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 3 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function heatedFrotherActions(
  batch: ApplianceBatch,
  targetC = 45,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const clampedTarget = Math.max(45, Math.min(65, targetC));
  const controller = isRecord(context.checkpoint?.controller)
    ? context.checkpoint.controller
    : null;
  const jugC =
    controller !== null && typeof controller.jug_c === "number"
      ? controller.jug_c
      : 20;
  const warmBatch: ApplianceBatch = {
    ...batch,
    temperature_c: Math.max(
      38,
      Math.min(clampedTarget - 2, batch.temperature_c),
    ),
    resistance: Math.max(2.0, batch.resistance),
  };
  const advanceSeconds = jugC >= 35 ? 30 : 42;
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch: warmBatch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "heated-mix",
        target_c: clampedTarget,
      },
    },
    { kind: "advance", seconds: advanceSeconds },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

function ovenCheckpointState(checkpoint: Record<string, unknown> | null): {
  kind: string | null;
  targetC: number | null;
  chamberC: number;
} {
  if (checkpoint === null || !isRecord(checkpoint.controller))
    return { kind: null, targetC: null, chamberC: 22 };
  const oven = isRecord(checkpoint.controller.oven)
    ? checkpoint.controller.oven
    : null;
  if (oven === null) return { kind: null, targetC: null, chamberC: 22 };
  const state = isRecord(oven.state) ? oven.state : null;
  return {
    kind: typeof state?.kind === "string" ? state.kind : null,
    targetC: typeof state?.target_c === "number" ? state.target_c : null,
    chamberC: typeof oven.chamber_c === "number" ? oven.chamber_c : 22,
  };
}

export function ovenPreheatActions(
  targetC = 55,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const current = ovenCheckpointState(context.checkpoint);
  if (current.kind === "ready" && current.targetC === targetC) {
    return [
      { kind: "advance", seconds: 2 },
      { kind: "require", state: "ready" },
    ];
  }
  const settleSeconds =
    Math.abs(current.chamberC - targetC) <= 3
      ? 12
      : Math.max(
          20,
          Math.min(500, Math.ceil((targetC - current.chamberC) * 2.2 + 18)),
        );
  return [
    { kind: "stop" },
    { kind: "start", program: { kind: "preheat", target_c: targetC } },
    { kind: "advance", seconds: settleSeconds },
    { kind: "require", state: "ready" },
  ];
}

export function ovenBakeActions(
  batch: ApplianceBatch,
  targetC = 55,
  durationSeconds = 12,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    10,
    Math.min(60, Math.round(durationSeconds)),
  );
  const current = ovenCheckpointState(context.checkpoint);
  const actions: ApplianceAction[] = [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
  ];
  if (current.kind !== "ready" || current.targetC !== targetC) {
    const preheatSeconds =
      Math.abs(current.chamberC - targetC) <= 3
        ? 12
        : Math.max(
            20,
            Math.min(500, Math.ceil((targetC - current.chamberC) * 2.2 + 18)),
          );
    actions.push(
      { kind: "stop" },
      { kind: "start", program: { kind: "preheat", target_c: targetC } },
      { kind: "advance", seconds: preheatSeconds },
      { kind: "require", state: "ready" },
    );
  }
  actions.push(
    {
      kind: "start",
      program: {
        kind: "bake",
        target_c: targetC,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  );
  return actions;
}

export function chillerActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    3,
    Math.min(20, Math.round(durationSeconds)),
  );
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "start", program: { kind: "refrigerate" } },
    { kind: "advance", seconds: clampedDuration },
    { kind: "stop" },
    { kind: "remove-contents" },
  ];
}

export function dishwasherActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    4,
    Math.min(20, Math.round(durationSeconds)),
  );
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "prepare-wash" },
    { kind: "advance", seconds: clampedDuration },
    { kind: "stop" },
    { kind: "remove-contents" },
  ];
}

export function espressoActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(
    4,
    Math.min(18, Math.round(durationSeconds)),
  );
  const placeSeconds = Math.max(2, Math.floor(clampedDuration / 3));
  const brewSeconds = Math.max(2, clampedDuration - placeSeconds);
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    {
      kind: "start",
      program: { kind: "espresso-warmup", coffee_c: 93, steam_c: 125 },
    },
    { kind: "set-shot-dose", group: "left", slot: "two", duration_s: 18 },
    { kind: "move-cup", outlet: "left", position: "removed" },
    { kind: "advance", seconds: placeSeconds },
    { kind: "move-cup", outlet: "left", position: "placed" },
    { kind: "advance", seconds: brewSeconds },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function defaultMorningShiftFaultInjections(): ReadonlyMap<
  string,
  ApplianceFaultInjectionSpec
> {
  const map = new Map<string, ApplianceFaultInjectionSpec>();

  map.set("hazelnut-preparation-batches#0/mix", {
    faultKind: "mixer-guard-open",
    description:
      "Hobart HL200 safety guard opens mid-planetary-mix, pausing the motor with remaining time in checkpoint; restore closes guard and resumes.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ??
        batchSpec(
          "hazelnut-preparation-batches-0-mix",
          0.248,
          22,
          3200,
          1.08,
          0.4,
        );
      return [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
        { kind: "advance", seconds: 1 },
        {
          kind: "start",
          program: { kind: "planetary", setting: 2, duration_s: 4 },
        },
        { kind: "advance", seconds: 2 },
        { kind: "guard", open: true },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "guard", open: false },
        { kind: "advance", seconds: 2 },
        { kind: "resume" },
        { kind: "advance", seconds: 6 },
        { kind: "require", state: "complete" },
        { kind: "require", state: "stopped" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("sesame-batches#0/blend", {
    faultKind: "blender-lid-open",
    description:
      "Vitamix Quiet One lid lifts mid-blend, triggering SIM_LID_OPEN motor fault in checkpoint; restore closes lid, resets fault, and finishes blend.",
    buildFaultActions(binding) {
      const base =
        binding.batch ?? batchSpec("sesame-0-blend", 0.76, 62, 3600, 1.04, 2.5);
      const dampedBatch: ApplianceBatch = {
        ...base,
        resistance: Math.max(2.5, base.resistance),
      };
      return [
        {
          kind: "set-contents",
          contents: { kind: "loaded", batch: dampedBatch },
        },
        { kind: "advance", seconds: 1 },
        {
          kind: "start",
          program: { kind: "blend", percent: 45, duration_s: 4 },
        },
        { kind: "advance", seconds: 2 },
        { kind: "lid", open: true },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "lid", open: false },
        { kind: "advance", seconds: 2 },
        { kind: "reset" },
        {
          kind: "start",
          program: { kind: "blend", percent: 45, duration_s: 3 },
        },
        { kind: "advance", seconds: 6 },
        { kind: "require", state: "complete" },
        { kind: "require", state: "stopped" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("load-hazelnut-a#0/bake", {
    faultKind: "oven-door-open",
    description:
      "Maruzen MBCO-5E door opens 5 s into bake, pausing the bake timer in checkpoint; restore closes door, recovers chamber heat, and resumes remaining bake.",
    buildFaultActions(binding, context) {
      const batch =
        binding.batch ??
        batchSpec("load-hazelnut-a-0-bake", 0.36, 24, 3100, 1.05, 0.2);
      const current = ovenCheckpointState(context.checkpoint);
      const actions: ApplianceAction[] = [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
      ];
      if (current.kind !== "ready" || current.targetC !== 55) {
        const preheatSeconds =
          Math.abs(current.chamberC - 55) <= 3
            ? 12
            : Math.max(
                20,
                Math.min(500, Math.ceil((55 - current.chamberC) * 2.2 + 18)),
              );
        actions.push(
          { kind: "stop" },
          { kind: "start", program: { kind: "preheat", target_c: 55 } },
          { kind: "advance", seconds: preheatSeconds },
          { kind: "require", state: "ready" },
        );
      }
      actions.push(
        {
          kind: "start",
          program: { kind: "bake", target_c: 55, duration_s: 12 },
        },
        { kind: "advance", seconds: 5 },
        { kind: "door", open: true, right: false },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      );
      return actions;
    },
    buildRestoreActions() {
      return [
        { kind: "door", open: false, right: false },
        { kind: "advance", seconds: 3 },
        { kind: "resume" },
        { kind: "advance", seconds: 8 },
        { kind: "require", state: "complete" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("load-hazelnut-a#0/clean-mould", {
    faultKind: "dishwasher-door-open",
    description:
      "Winterhalter UC-L door opens during wash filling, latching DoorFault in checkpoint; restore closes door, re-prepares wash cycle, and sanitizes.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ??
        batchSpec("load-hazelnut-a-0-clean-mould", 0.25, 25, 4180, 1.0, 0.02);
      return [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
        { kind: "prepare-wash" },
        { kind: "advance", seconds: 1 },
        { kind: "door", open: true, right: false },
        { kind: "advance", seconds: 1 },
        { kind: "prepare-wash" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "door", open: false, right: false },
        { kind: "advance", seconds: 2 },
        { kind: "prepare-wash" },
        { kind: "advance", seconds: 5 },
        { kind: "stop" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("steak-and-pepper-pie-batches#0/line-tins-a", {
    faultKind: "pastry-bench-unfloured",
    description:
      "Pastry bench starts shortcrust sheeting with bench flour wiped off, latching PastryState::Fault in checkpoint; restore dusts bench flour and completes tin lining.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ??
        batchSpec("steak-and-pepper-line-tins-a", 0.33, 8, 1900, 1.15, 0.6);
      return buildPastryUnflouredFaultActions(batch);
    },
    buildRestoreActions() {
      return buildPastryUnflouredRestoreActions();
    },
  });

  return map;
}

function isAttemptRunner(
  runtime: ApplianceWasmRuntimeSource,
): runtime is ApplianceAttemptRunner {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    "runAttempt" in runtime &&
    typeof runtime.runAttempt === "function"
  );
}

function runApplianceAttemptOnWasm(
  activeRuntime: ApplianceWasmRuntime,
  request: ApplianceRequest,
  taskId: string,
  appliance: ApplianceName,
): ApplianceResult {
  const text = exchangeNow(
    activeRuntime,
    { encode: strToU8, decode: strFromU8 },
    JSON.stringify({ op: "appliance", request: JSON.parse(request.file) }),
  );
  const reply = parseJsonOrNull(text);
  if (
    !isRecord(reply) ||
    reply.kind !== "appliance" ||
    typeof reply.file !== "string"
  )
    throw new Error(
      `Wasm appliance_run failed on ${taskId} (${appliance}): ${text.slice(0, 400)}`,
    );
  return parseApplianceResult(reply.file, request);
}

function parseCheckpointObject(
  result: ApplianceResult,
): Record<string, unknown> | null {
  try {
    // The continuation is a checkpoint envelope; its fields are the payload.
    const parsed: unknown = JSON.parse(result.file);
    return isRecord(parsed) ? checkpointBody(parsed.continuation) : null;
  } catch {
    return null;
  }
}

function linkedCellForScheduledTask(
  task: Pick<ScheduledTaskDescriptor, "instanceId" | "workflowId" | "taskKey">,
): LinkedCellId | null {
  if (
    task.workflowId === "pour-over-brew" ||
    task.instanceId.startsWith("pour-over-order") ||
    task.taskKey === "wash-jug" ||
    task.taskKey === "clean-batch-vessels"
  ) {
    return "pour-over-cell";
  }
  if (
    task.workflowId === "espresso-orders" ||
    task.instanceId.startsWith("espresso-order") ||
    task.workflowId === "sesame-drink" ||
    task.instanceId.startsWith("sesame-orders")
  ) {
    return "espresso-cell";
  }
  if (
    task.taskKey === "stage-pan" ||
    task.taskKey === "stage-pan-b" ||
    task.taskKey === "transfer-cold-carrier" ||
    task.taskKey === "bake" ||
    task.taskKey === "cool" ||
    task.workflowId.includes("tea") ||
    task.workflowId.startsWith("load-")
  ) {
    return "tea-pan-cell";
  }
  return null;
}

type AttemptTrackingMaps = Readonly<{
  continuations: Map<ApplianceName, ApplianceContinuation>;
  checkpoints: Map<ApplianceName, Record<string, unknown>>;
  checkpointDigests: Map<ApplianceName, string>;
  instanceBatchTemperatures: Map<string, number>;
  instanceThermalStates: Map<string, BatchThermalState>;
  workflowLatestStates: Map<string, BatchThermalState>;
}>;

/**
 * Shared finalization for both normal and checkpoint-restored appliance attempts.
 * Keeps continuation chains, thermal handoffs, and coupled physics identical.
 */
async function finalizeApplianceAttempt(
  params: Readonly<{
    index: number;
    binding: RecipeApplianceTaskBinding;
    request: ApplianceRequest;
    result: ApplianceResult;
    actionsForBatch: readonly ApplianceAction[];
    resumedDigest: string | null;
    upstreamThermal: BatchThermalState | null;
    maps: AttemptTrackingMaps;
    cascadeShiftedByUs: number;
    cascadeHeldByFaultTaskIds: readonly string[];
    faultRestore?: ExecutedApplianceFaultRestoreRecord;
  }>,
): Promise<ExecutedApplianceTaskRecord> {
  const { binding, result, maps } = params;
  const recordingDigest = await sha256Hex(result.file);
  const nextCheckpoint = parseCheckpointObject(result);
  if (nextCheckpoint === null) {
    throw new Error(
      `Missing continuation checkpoint in recording for ${binding.taskId}`,
    );
  }
  const checkpointDigest = await sha256Hex(canonicalJson(nextCheckpoint));
  maps.continuations.set(binding.appliance, result.continuation);
  maps.checkpoints.set(binding.appliance, nextCheckpoint);
  maps.checkpointDigests.set(binding.appliance, checkpointDigest);

  const transferredLast = result.transferred.at(-1);
  if (transferredLast !== undefined) {
    maps.instanceBatchTemperatures.set(
      binding.instanceId,
      transferredLast.temperature_c,
    );
    const state: BatchThermalState = {
      instanceId: binding.instanceId,
      temperatureC: transferredLast.temperature_c,
      completedAtUs: binding.completedAtUs,
    };
    maps.instanceThermalStates.set(binding.instanceId, state);
    const prefix = binding.instanceId.split("#")[0] ?? binding.instanceId;
    maps.workflowLatestStates.set(prefix, state);
  }

  const firstSample = result.samples[0];
  const lastSample = result.samples.at(-1);
  const simulatedSeconds =
    firstSample !== undefined && lastSample !== undefined
      ? Number((lastSample.timeSeconds - firstSample.timeSeconds).toFixed(4))
      : 0;

  let inputBatch = binding.batch;
  for (const action of params.actionsForBatch) {
    if (action.kind === "set-contents" && action.contents.kind === "loaded") {
      inputBatch = action.contents.batch;
      break;
    }
  }

  const coupledPhysics = computeCoupledBatchPhysics(
    binding,
    params.upstreamThermal,
    inputBatch,
    result,
    simulatedSeconds,
  );

  return {
    index: params.index,
    taskId: binding.taskId,
    instanceId: binding.instanceId,
    workflowId: binding.workflowId,
    taskKey: binding.taskKey,
    startedAtUs: binding.startedAtUs,
    completedAtUs: binding.completedAtUs,
    ...(params.cascadeShiftedByUs > 0
      ? {
          cascadeShiftedByUs: params.cascadeShiftedByUs,
          cascadeHeldByFaultTaskIds: params.cascadeHeldByFaultTaskIds,
        }
      : {}),
    category: binding.category,
    appliance: binding.appliance,
    label: binding.label,
    resumedFromCheckpointDigest: params.resumedDigest,
    request: params.request,
    result,
    recordingDigest,
    checkpointDigest,
    sampleCount: result.samples.length,
    simulatedSeconds,
    inputBatch,
    transferred: result.transferred,
    finalController: nextCheckpoint.controller ?? null,
    finalDisplays: lastSample?.displays ?? [],
    coupledPhysics,
    ...(params.faultRestore !== undefined
      ? { faultRestore: params.faultRestore }
      : {}),
  };
}

export async function executeRecipeApplianceTasks(
  bindings: readonly RecipeApplianceTaskBinding[],
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  const runId = (options.runId ?? "recipe-appliance-wasm")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const maps: AttemptTrackingMaps = {
    continuations: new Map<ApplianceName, ApplianceContinuation>(
      options.initialContinuations,
    ),
    checkpoints: new Map<ApplianceName, Record<string, unknown>>(),
    checkpointDigests: new Map<ApplianceName, string>(),
    instanceBatchTemperatures: new Map<string, number>(),
    instanceThermalStates: new Map<string, BatchThermalState>(),
    workflowLatestStates: new Map<string, BatchThermalState>(),
  };
  const records: ExecutedApplianceTaskRecord[] = [];
  const faultRestores: ExecutedApplianceFaultRestoreRecord[] = [];
  const activeFaultEntries: {
    faultRecord: ExecutedApplianceFaultRestoreRecord;
    startedAtUs: number;
    recoveryDelaySeconds: number;
    recoveryDelayUs: number;
  }[] = [];
  const faultInjections = options.faultInjections ?? null;
  const asyncRunner = isAttemptRunner(runtime) ? runtime : null;
  const isFactory = asyncRunner === null && typeof runtime === "function";
  let activeRuntime: ApplianceWasmRuntime | null =
    asyncRunner !== null || isFactory
      ? null
      : (runtime as ApplianceWasmRuntime);

  async function runAttempt(
    request: ApplianceRequest,
    taskId: string,
    appliance: ApplianceName,
    refreshRuntime: boolean,
  ): Promise<ApplianceResult> {
    if (asyncRunner !== null) {
      return asyncRunner.runAttempt(request, taskId, appliance);
    }
    if (activeRuntime === null || (isFactory && refreshRuntime)) {
      activeRuntime = await (
        runtime as () => Promise<ApplianceWasmRuntime> | ApplianceWasmRuntime
      )();
    }
    return runApplianceAttemptOnWasm(activeRuntime, request, taskId, appliance);
  }

  for (let index = 0; index < bindings.length; index++) {
    if (options.signal?.aborted) {
      throw new Error("Appliance physics verification was cancelled.");
    }
    const binding = bindings[index];
    if (binding === undefined) continue;
    const refresh = index % 15 === 0;
    const priorContinuation = maps.continuations.get(binding.appliance) ?? null;
    const priorCheckpoint = maps.checkpoints.get(binding.appliance) ?? null;
    const resumedDigest = maps.checkpointDigests.get(binding.appliance) ?? null;
    const upstreamThermal = resolveUpstreamThermalHandoff(
      binding,
      maps.instanceThermalStates,
      maps.workflowLatestStates,
    );
    const prevTemp =
      maps.instanceBatchTemperatures.get(binding.instanceId) ??
      upstreamThermal?.temperatureC ??
      null;
    const context: ApplianceTaskContext = {
      continuation: priorContinuation,
      checkpoint: priorCheckpoint,
      previousInstanceBatchTemperatureC: prevTemp,
    };

    const upstreamFaults = activeFaultEntries.filter(
      (entry) => entry.startedAtUs <= binding.startedAtUs,
    );
    const cascadeShiftedByUs = upstreamFaults.reduce(
      (sum, entry) => sum + entry.recoveryDelayUs,
      0,
    );
    const cascadeHeldByFaultTaskIds = upstreamFaults.map(
      (entry) => entry.faultRecord.taskId,
    );

    const faultSpec = faultInjections?.get(binding.taskId);
    if (faultSpec !== undefined) {
      const faultActions = faultSpec.buildFaultActions(binding, context);
      const faultAttemptId = sanitizeAttemptId(
        `${binding.instanceId}-${binding.taskKey}-${binding.appliance}-fault`,
        index,
      );
      const initialContents: ApplianceContents = { kind: "empty" };
      const faultRequest =
        priorContinuation === null
          ? freshApplianceRequest(
              binding.appliance,
              runId,
              faultAttemptId,
              initialContents,
              faultActions,
            )
          : priorContinuation.request(runId, faultAttemptId, faultActions);

      const faultResult = await runAttempt(
        faultRequest,
        binding.taskId,
        binding.appliance,
        refresh,
      );
      if (faultResult.outcome.kind !== "rejected") {
        throw new Error(
          `Expected mid-cycle fault rejection on ${binding.taskId} (${binding.appliance}), but attempt completed without fault`,
        );
      }
      const faultCheckpoint = parseCheckpointObject(faultResult);
      if (faultCheckpoint === null) {
        throw new Error(
          `Missing fault continuation checkpoint on ${binding.taskId}`,
        );
      }
      const faultRecordingDigest = await sha256Hex(faultResult.file);
      const faultCheckpointDigest = await sha256Hex(
        canonicalJson(faultCheckpoint),
      );
      const faultFirstSample = faultResult.samples[0];
      const faultLastSample = faultResult.samples.at(-1);
      const faultSimulatedSeconds =
        faultFirstSample !== undefined && faultLastSample !== undefined
          ? Number(
              (
                faultLastSample.timeSeconds - faultFirstSample.timeSeconds
              ).toFixed(4),
            )
          : 0;

      const restoreActions = faultSpec.buildRestoreActions(
        binding,
        faultCheckpoint,
      );
      const restoreAttemptId = sanitizeAttemptId(
        `${binding.instanceId}-${binding.taskKey}-${binding.appliance}-restore`,
        index,
      );
      const restoreRequest = faultResult.continuation.request(
        runId,
        restoreAttemptId,
        restoreActions,
      );
      const restoreResult = await runAttempt(
        restoreRequest,
        binding.taskId,
        binding.appliance,
        true,
      );
      if (restoreResult.outcome.kind !== "completed") {
        throw new Error(
          `Checkpoint-restore attempt on ${binding.taskId} (${binding.appliance}) rejected at action ${restoreResult.outcome.action}: ${restoreResult.outcome.message}`,
        );
      }

      const recoveryDelaySeconds = Number(
        (faultSimulatedSeconds + 30).toFixed(4),
      );
      const recoveryDelayUs = Math.round(recoveryDelaySeconds * 1_000_000);
      const draftRecord = await finalizeApplianceAttempt({
        index,
        binding,
        request: restoreRequest,
        result: restoreResult,
        actionsForBatch: faultActions,
        resumedDigest,
        upstreamThermal,
        maps,
        cascadeShiftedByUs: cascadeShiftedByUs + recoveryDelayUs,
        cascadeHeldByFaultTaskIds: [
          ...cascadeHeldByFaultTaskIds,
          binding.taskId,
        ],
      });

      const faultRestoreRecord: ExecutedApplianceFaultRestoreRecord = {
        taskId: binding.taskId,
        instanceId: binding.instanceId,
        workflowId: binding.workflowId,
        taskKey: binding.taskKey,
        appliance: binding.appliance,
        category: binding.category,
        faultKind: faultSpec.faultKind,
        description: faultSpec.description,
        priorCheckpointDigest: resumedDigest,
        faultAttemptId,
        faultRejectedActionIndex: faultResult.outcome.action,
        faultMessage: faultResult.outcome.message,
        faultRecordingDigest,
        faultCheckpointDigest,
        faultControllerState: faultCheckpoint.controller ?? null,
        faultSampleCount: faultResult.samples.length,
        faultSimulatedSeconds,
        restoreAttemptId,
        resumedFromFaultCheckpointDigest: faultCheckpointDigest,
        restoredRecordingDigest: draftRecord.recordingDigest,
        restoredCheckpointDigest: draftRecord.checkpointDigest,
        restoredSampleCount: restoreResult.samples.length,
        restoredSimulatedSeconds: draftRecord.simulatedSeconds,
        transferredCount: restoreResult.transferred.length,
      };
      faultRestores.push(faultRestoreRecord);
      activeFaultEntries.push({
        faultRecord: faultRestoreRecord,
        startedAtUs: binding.startedAtUs,
        recoveryDelaySeconds,
        recoveryDelayUs,
      });

      const record: ExecutedApplianceTaskRecord = {
        ...draftRecord,
        faultRestore: faultRestoreRecord,
      };
      records.push(record);
      options.onProgress?.(records.length, bindings.length, record);
      continue;
    }

    const actions = binding.buildActions(context);
    const attemptId = sanitizeAttemptId(
      `${binding.instanceId}-${binding.taskKey}-${binding.appliance}`,
      index,
    );
    const initialContents: ApplianceContents = { kind: "empty" };
    const request =
      priorContinuation === null
        ? freshApplianceRequest(
            binding.appliance,
            runId,
            attemptId,
            initialContents,
            actions,
          )
        : priorContinuation.request(runId, attemptId, actions);

    const result = await runAttempt(
      request,
      binding.taskId,
      binding.appliance,
      refresh,
    );
    if (
      result.outcome.kind !== "completed" &&
      options.continueOnRejection !== true
    ) {
      throw new Error(
        `Appliance task ${binding.taskId} (${binding.appliance}) rejected at action ${result.outcome.action}: ${result.outcome.message}`,
      );
    }

    const record = await finalizeApplianceAttempt({
      index,
      binding,
      request,
      result,
      actionsForBatch: actions,
      resumedDigest,
      upstreamThermal,
      maps,
      cascadeShiftedByUs,
      cascadeHeldByFaultTaskIds,
    });
    records.push(record);
    options.onProgress?.(records.length, bindings.length, record);
  }

  const allScheduledTasks: readonly Pick<
    ScheduledTaskDescriptor,
    | "taskId"
    | "instanceId"
    | "workflowId"
    | "taskKey"
    | "startedAtUs"
    | "completedAtUs"
  >[] =
    options.scheduledTasks && options.scheduledTasks.length > 0
      ? options.scheduledTasks
      : bindings;
  const canonicalCells: readonly LinkedCellId[] = [
    "tea-pan-cell",
    "espresso-cell",
    "pour-over-cell",
  ];
  const faultCascades: MultiBatchFaultCascadeRecord[] = activeFaultEntries.map(
    (entry) => {
      const downstreamTasks = allScheduledTasks.filter(
        (task) =>
          task.taskId !== entry.faultRecord.taskId &&
          task.startedAtUs >= entry.startedAtUs,
      );
      const batchSet = new Set<string>([entry.faultRecord.instanceId]);
      for (const task of downstreamTasks) {
        batchSet.add(task.instanceId);
      }
      const linkedCellTransfers: LinkedCellCascadeTransferRecord[] = [];
      const cellSet = new Set<LinkedCellId>();
      for (const task of downstreamTasks) {
        const cellId = linkedCellForScheduledTask(task);
        if (cellId === null) continue;
        cellSet.add(cellId);
        const baselineStartSeconds = Number(
          (task.startedAtUs / 1_000_000).toFixed(4),
        );
        const cascadedStartSeconds = Number(
          (baselineStartSeconds + entry.recoveryDelaySeconds).toFixed(4),
        );
        linkedCellTransfers.push({
          cellId,
          transferTaskId: task.taskId,
          batchInstanceId: task.instanceId,
          workflowId: task.workflowId,
          taskKey: task.taskKey,
          baselineStartSeconds,
          cascadedStartSeconds,
          delaySeconds: entry.recoveryDelaySeconds,
          heldByAppliance: entry.faultRecord.appliance,
          heldByFaultKind: entry.faultRecord.faultKind,
          releasedByCheckpointDigest:
            entry.faultRecord.restoredCheckpointDigest,
          status: "recovered",
        });
      }
      return {
        faultTaskId: entry.faultRecord.taskId,
        faultInstanceId: entry.faultRecord.instanceId,
        appliance: entry.faultRecord.appliance,
        faultKind: entry.faultRecord.faultKind,
        faultCheckpointDigest: entry.faultRecord.faultCheckpointDigest,
        restoredCheckpointDigest: entry.faultRecord.restoredCheckpointDigest,
        faultSimulatedSeconds: entry.faultRecord.faultSimulatedSeconds,
        restoredSimulatedSeconds: entry.faultRecord.restoredSimulatedSeconds,
        recoveryDelaySeconds: entry.recoveryDelaySeconds,
        affectedBatches: [...batchSet],
        affectedCells: canonicalCells.filter((cell) => cellSet.has(cell)),
        shiftedTaskCount: downstreamTasks.length,
        linkedCellTransfers,
      };
    },
  );

  const digestRecord: Record<string, string> = {};
  for (const [appliance, digest] of maps.checkpointDigests) {
    digestRecord[appliance] = digest;
  }

  const facilityUtilities = computeFacilityUtilityLoadSummary(records);
  const massBalance = computeQualityGateMassBalanceSummary(records);
  const carrierReturnSummary = computeContinuousWaveCarrierReturnSummary(
    allScheduledTasks,
    records,
  );
  return {
    runId,
    taskCount: records.length,
    applianceCount: maps.continuations.size,
    records,
    faultRestores,
    faultCascades,
    facilityUtilities,
    massBalance,
    carrierReturnSummary,
    continuations: maps.continuations,
    checkpointDigests: digestRecord,
  };
}
