import { HUMAN_CELL_TRANSFER } from "./human-cell-transfer.ts";
import {
  parseProductionManualTasks,
  validProductionWorkflow,
  type ProductionManualTask,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import { err, ok, type Result } from "../../result.ts";
import {
  financierOperations,
  type StationId,
  type Settings,
} from "@purin-labs/bakery-model/bakery";
import type {
  ProductionWorkcells,
  ProductionWorkcell,
  PlannedProductionWorkcell,
} from "./production-workcells.ts";
import { physicsDuration, physicsOutcome } from "./physics-playback.ts";
import { coldCell, type CellId, nativeSkills } from "./workcell-instances.ts";
import {
  NO_FAULTS,
  absentBaker,
  coldTrayHandlingSeconds,
  handlingTaskId,
  outageResourceName,
  recoveryFor,
  resourceOutage,
  type OutageResource,
} from "./run-faults.ts";
import {
  workcellResources,
  type WorkcellResource,
  type WorkcellResourceId,
} from "./workcell-input.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever, compareCodePoints } from "@purin-labs/std";
import {
  route,
  resolveScheduleLayout,
  station,
  stationLabel,
  stations,
  transferTiming,
  travelSeconds,
  workerStart,
  type ResolvedScheduleLayout,
  type ScheduleSpatialLayout,
  type Station,
} from "./schedule-layout.ts";
export {
  distance,
  station,
  stationLabel,
  stations,
  transferTiming,
  travelSeconds,
  type ResolvedScheduleLayout,
  type ScheduleSpatialLayout,
  type Station,
} from "./schedule-layout.ts";
export type {
  CafeBeverageRecipeId,
  VitrineCustomerOrder,
  VitrineOrderChannel,
  VitrineRefillWave,
  VitrineRushPresetId,
  VitrineStockSnapshot,
} from "./vitrine-types.ts";

export {
  summarizeVitrineShiftService,
  exportVitrineShiftServiceJson,
  exportVitrineShiftServiceCsv,
} from "./shift-report.ts";
import { resolved } from "./schedule-types.ts";
import type {
  BakeryTask,
  BatchProcedure,
  FinancierRunInput,
  HandlingFailure,
  HumanId,
  HumanResource,
  Interval,
  NativeBakeryTask,
  NativeHold,
  NativeReservation,
  OvenCycle,
  OvenState,
  Process,
  Release,
  ResolvedRunInput,
  Run,
  RunData,
  RunModel,
  ScheduleVariant,
  SimulationStep,
  StationResource,
  Step,
  TaskEvent,
  UnresolvedWait,
  Wait,
  Work,
  WorkcellCapability,
  Worker,
} from "./schedule-types.ts";
import { staffRoleProfileFor, stationZone } from "./kitchen-zones.ts";
import { clock, outageAt } from "./schedule-queries.ts";
export type {
  BakeryTask,
  BakeryTaskId,
  Batch,
  FinancierRunInput,
  Handoff,
  HumanId,
  HumanResource,
  Interval,
  KitchenZoneId,
  NativeBakeryTask,
  NativeHold,
  NativeReservation,
  OvenCycle,
  Process,
  ResolvedRunInput,
  Run,
  ScheduleVariant,
  TaskEvent,
  TaskSnapshot,
  Wait,
  WorkcellCapability,
} from "./schedule-types.ts";
export {
  staffRoleProfileFor,
  stationZoneLabel,
  transferZoneHandoff,
} from "./kitchen-zones.ts";
export {
  type BatchSnapshot,
  type MachineState,
  batchAt,
  clock,
  describe,
  doorAt,
  humanResource,
  machineAt,
  metrics,
  outageAt,
  taskAt,
  workName,
  workerAt,
  workerTasks,
} from "./schedule-queries.ts";
export {
  PLAN_61A_MASS_BALANCE,
  plan61AOperationSubsteps,
  plan61ASubstepAt,
} from "./plan-61a-substeps.ts";
export {
  CAFE_BEVERAGE_ROTATION,
  VITRINE_ORDER_CHANNELS,
  VITRINE_RUSH_PRESETS,
  addCustomVitrineOrder,
  applyRecommendedVitrineCapacity,
  exportCustomVitrineOrdersJson,
  getActiveVitrineChannelFilter,
  getActiveVitrineRushPreset,
  getAutoScaleVitrineBatches,
  getSnapVitrineOrdersToWaves,
  getVitrineDemandRevision,
  importCustomVitrineOrdersJson,
  nudgeVitrineOrderArrivalMinutes,
  recommendedCapacityForRushPreset,
  removeCustomVitrineOrder,
  resetCustomVitrineOrders,
  restoreVitrineDemandSnapshot,
  setActiveVitrineChannelFilter,
  setActiveVitrineRushPreset,
  setAutoScaleVitrineBatches,
  setSnapVitrineOrdersToWaves,
  setVitrineOrderArrivalMinutes,
  setVitrineOrderItems,
  shiftAllVitrineOrderArrivals,
  shouldApplyVitrineCapacity,
  snapOrderMinutesToNearestWave,
  subscribeVitrineDemandHistory,
  subscribeVitrineRushPreset,
} from "./vitrine-demand.ts";
export { vitrineStockAt } from "./vitrine-stock.ts";

const steps = procedureSteps();
const bakingStepIndex = steps.findIndex(isBakingStep);

function isBakingStep(step: Step): boolean {
  return step.kind === "process" && step.operation === "bake";
}

function procedureSteps(): readonly Step[] {
  const result: Step[] = [];
  let previous: StationId | null = null;
  for (const item of financierOperations) {
    if (previous !== null && previous !== item.station) {
      result.push({ kind: "transfer", station: item.station });
    }
    result.push({
      kind: "process",
      station: item.station,
      operation: item.operation,
      attended: item.attended,
    });
    previous = item.station;
  }
  return result;
}

function productionSteps(
  batchId: string,
  operations: readonly ProductionWorkcell[],
): readonly Step[] {
  if (operations.length === 0) return steps;
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (step.kind !== "process" || step.operation !== "cool") continue;
    for (const operation of operations)
      if (operation.batchId === batchId)
        result.push(...chainSteps(operation, [operation], []));
  }
  return result;
}

// One tray chain holds the cell from staging through clearance: its skills
// continue the same MuJoCo state, so no other tray may enter between them.
function chainSteps(
  root: ProductionWorkcell,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
): readonly Step[] {
  const result: Step[] = [
    { kind: "handoff", station: "cool", phase: "stage", operation: root },
  ];
  let last = root;
  for (const operation of operations) {
    if (!sameTray(root, operation)) continue;
    if (operation.start.kind === "restaged")
      result.push({
        kind: "handoff",
        station: "cool",
        phase: "transfer",
        operation,
      });
    result.push({ kind: "native", station: "cool", operation });
    last = operation;
  }
  for (const operation of planned)
    if (sameTray(root, operation))
      result.push({ kind: "planned", station: "cool", operation });
  result.push({
    kind: "handoff",
    station: "cool",
    phase: "clear",
    operation: last,
  });
  return result;
}

function sameTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return operation.batchId === root.batchId && operation.tray === root.tray;
}

function chainRoot(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): string {
  return `batch:${operation.batchId}:native:${operation.tray}`;
}

function nativeTaskId(operation: ProductionWorkcell): NativeBakeryTask["id"] {
  const prefix = `batch:${operation.batchId}:native:`;
  if (!operation.id.startsWith(prefix))
    throw new Error("Native operation identity is invalid");
  return `batch:${operation.batchId}:native:${operation.id.slice(prefix.length)}`;
}

// A continuation's recording contains its predecessor's evidence as a prefix.
export function continuationPrefix(operation: ProductionWorkcell): number {
  switch (operation.start.kind) {
    case "reset":
    case "restaged":
      return 0;
    case "continuation":
      return physicsDuration(operation.start.handoff.predecessor);
    case "continued":
      return operation.start.prefixSeconds;
  }
}

function rehearsalBatches(
  plan: ProductionWorkcells,
): readonly BatchProcedure[] {
  const batches: BatchProcedure[] = [];
  for (const root of plan.operations) {
    if (root.step !== 1) continue;
    batches.push({
      id: root.batchId,
      quantity: plan.settings.piecesPerTray,
      trays: 1,
      release: 0,
      deadline: plan.settings.horizonMinutes * 60,
      steps: chainSteps(root, plan.operations, plan.planned),
    });
  }
  return batches;
}

function stationResources(settings: Settings): readonly StationResource[] {
  return stations.map(stationResource.bind(null, settings));
}

function stationResource(settings: Settings, item: Station): StationResource {
  return {
    kind: "station",
    id: item.id,
    capacity:
      item.id === "cool"
        ? settings.rackTrays
        : item.id === "bake"
          ? settings.ovenTrays
          : 1,
    unit: item.id === "cool" || item.id === "bake" ? "trays" : "batches",
  };
}

function humanResources(
  settings: Settings,
  layout: ResolvedScheduleLayout | undefined,
): readonly HumanResource[] {
  const resources: HumanResource[] = [];
  for (let id = 0; id < settings.workerCount; id++) {
    const start = workerStart(id, layout);
    const profile = staffRoleProfileFor(id);
    resources.push({
      kind: "human",
      id: `human-${id + 1}`,
      name: `Baker ${id + 1}`,
      role: profile.role,
      roleTitle: profile.roleTitle,
      shortRole: profile.shortRole,
      zone: profile.zone,
      zoneLabel: profile.zoneLabel,
      homeStation: profile.homeStation,
      start,
      capabilities: ["manual-processing", "tray-handling"],
    });
  }
  return resources;
}

function batchProcedures(
  settings: Settings,
  operations: readonly ProductionWorkcell[],
): readonly BatchProcedure[] {
  const batches: BatchProcedure[] = [];
  for (let index = 0; index < settings.batchCount; index++) {
    const id = String.fromCharCode(65 + index);
    batches.push({
      id,
      quantity: settings.piecesPerTray * settings.traysPerBatch,
      trays: settings.traysPerBatch,
      release: index * 120,
      deadline: 2700 + index * 1200,
      steps: productionSteps(id, operations),
    });
  }
  return batches;
}

export function resolveFinancierRun(
  settings: Settings,
  variant: ScheduleVariant,
  layout: ScheduleSpatialLayout | null,
): FinancierRunInput {
  return financierRun(settings, variant, [], layout);
}

/** Shared scenario fields already passed the production authoring boundary. */
export function resolveSavedOvenFinancierRun(
  definition: VariantBy<ProductionScenario, "route", "oven-rack">,
): FinancierRunInput {
  // A saved oven route records no floor layout, so it uses the built-in one.
  return financierRun(
    definition.settings,
    definition.variant,
    definition.manualTasks,
    null,
  );
}

/** Normalize saved or authored rules before either scheduler consumes them. */
export function resolveAuthoredFinancierRun(
  settings: Settings,
  variant: ScheduleVariant,
  raw: unknown,
  layout: ScheduleSpatialLayout | null,
): Result<
  FinancierRunInput,
  Readonly<{ code: "invalid_manual_tasks" | "invalid_dependencies" }>
> {
  const rules = parseProductionManualTasks(raw, settings, [], "cold-racking");
  if (rules === null) return err({ code: "invalid_manual_tasks" });
  if (!validProductionWorkflow(settings, [], rules, "cold-racking"))
    return err({ code: "invalid_dependencies" });
  return ok(financierRun(settings, variant, rules, layout));
}

function financierRun(
  settings: Settings,
  variant: ScheduleVariant,
  manualTasks: readonly ProductionManualTask[],
  spatial: ScheduleSpatialLayout | null,
): FinancierRunInput {
  const layout = resolveScheduleLayout(spatial, settings.workerCount);
  return {
    [resolved]: true,
    source: "financier",
    fingerprint: null,
    settings,
    variant,
    faults: NO_FAULTS,
    unit: "batch",
    manualTasks,
    batches: batchProcedures(settings, []),
    resources: humanResources(settings, layout),
    stationResources: stationResources(settings),
    workcellResources: [],
    workcells: [],
    ...(layout === undefined ? {} : { layout }),
  };
}

export function resolveProductionRun(
  plan: ProductionWorkcells,
  spatial: ScheduleSpatialLayout | null,
): ResolvedRunInput {
  const layout = resolveScheduleLayout(spatial, plan.settings.workerCount);
  const resources = new Map<WorkcellResourceId, WorkcellResource>();
  const cells = new Set<CellId>();
  for (const operation of plan.operations) {
    cells.add(operation.attempt.input.bindings.cell);
    for (const resource of workcellResources(operation.attempt.input)) {
      resources.set(resource.id, resource);
    }
  }
  return {
    [resolved]: true,
    source: "production",
    fingerprint: plan.fingerprint,
    settings: plan.settings,
    variant: plan.variant,
    faults: plan.faults,
    unit: plan.procedure === "rehearsal" ? "tray" : "batch",
    manualTasks: plan.manualTasks,
    batches:
      plan.procedure === "rehearsal"
        ? rehearsalBatches(plan)
        : batchProcedures(plan.settings, plan.operations),
    resources: humanResources(plan.settings, layout),
    stationResources: stationResources(plan.settings),
    workcellResources: [...resources.values()],
    workcells: [...cells].map(workcellCapability.bind(null, plan.procedure)),
    ...(layout === undefined ? {} : { layout }),
  };
}

function workcellCapability(
  procedure: ProductionWorkcells["procedure"],
  id: CellId,
): WorkcellCapability {
  const cell = coldCell(id);
  return {
    kind: "workcell-capability",
    id,
    skills: procedure === "rehearsal" ? nativeSkills(cell) : ["table-to-rack"],
    station: cell.station,
    capacity: cell.capacity,
  };
}

function hasCellId(id: CellId, cell: WorkcellCapability): boolean {
  return cell.id === id;
}

function runModel(input: ResolvedRunInput): RunModel {
  const shared = {
    settings: input.settings,
    manualTasks: input.manualTasks,
    variant: input.variant,
    faults: input.faults,
    unit: input.unit,
    batches: input.batches,
    resources: input.resources,
    stationResources: input.stationResources,
    workcellResources: input.workcellResources,
    ...(input.layout === undefined ? {} : { layout: input.layout }),
  };
  switch (input.source) {
    case "financier":
      return {
        ...shared,
        source: "financier",
        fingerprint: null,
        workcells: [],
      };
    case "production":
      return {
        ...shared,
        source: "production",
        fingerprint: input.fingerprint,
        workcells: input.workcells,
      };
    default:
      return assertNever(input, "Unexpected simulator state");
  }
}

function hasStationId(id: StationId, resource: StationResource): boolean {
  return resource.id === id;
}

export function simulate(
  settings: Settings,
  variant: ScheduleVariant,
  layout: ScheduleSpatialLayout | null,
): Run {
  const execution = simulateSteps(
    resolveFinancierRun(settings, variant, layout),
  );
  let step = execution.next();
  while (!step.done) step = execution.next();
  return step.value;
}

export function simulateProduction(
  plan: ProductionWorkcells,
  layout: ScheduleSpatialLayout | null,
): Run {
  const execution = simulateSteps(resolveProductionRun(plan, layout));
  let step = execution.next();
  while (!step.done) step = execution.next();
  return step.value;
}

export function* simulateSteps(
  input: ResolvedRunInput,
): Generator<SimulationStep, Run, void> {
  const { settings, variant, batches, layout } = input;
  const model = runModel(input);
  const workers: Worker[] = input.resources.map(workerFromResource);
  const work: Work[] = [];
  const intervals: Interval[] = [];
  const completions: { batch: string; time: number }[] = [];
  const reservations = new Map<StationId, Set<string>>();
  const checkpoints = new Set<number>([0]);
  const cycles: OvenCycle[] = [];
  const taskEvents: TaskEvent[] = [];
  const completedTasks = new Set<string>();
  const nativeHolds: NativeHold[] = [];
  const handlingFailures: HandlingFailure[] = [];
  const releases: Release[] = [];
  const nativeReservations: NativeReservation[] = [];
  const unresolvedWaits: UnresolvedWait[] = [];
  let emittedEvents = 0;
  let oven: OvenState = { kind: "idle" };
  for (const item of stations) {
    reservations.set(item.id, new Set());
  }
  for (const batch of batches) {
    work.push({
      batch,
      state: { kind: "pending", index: 0, location: null },
    });
  }
  const horizon = settings.horizonMinutes * 60;
  let time = 0;
  while (true) {
    for (const item of work) {
      if (item.state.kind !== "running") {
        continue;
      }
      const task = item.state.task;
      if (task.kind === "transfer" && time === task.pickup) {
        reservations.get(task.from)!.delete(item.batch.id);
        taskEvents.push({ kind: "picked-up", time, task });
      }
      if (task.end > time) {
        continue;
      }
      if (task.attended) {
        const worker = allocatedWorker(workers, task.executor);
        // A failed handling task keeps its baker until recovery.
        worker.state =
          task.kind === "handoff" && task.outcome === "failed"
            ? "busy"
            : "idle";
        worker.position = station(task.station, layout).handoff;
      }
      if (task.kind === "handoff" && task.outcome === "failed") {
        const recovery = recoveryFor(input.faults, task.id);
        const recoveredAt = recovery === null ? null : time + recovery.seconds;
        handlingFailures.push({ task, failedAt: time, recoveredAt });
        taskEvents.push({
          kind: "failed",
          time,
          task,
          evidence: { source: "injected-failure", bakeryTaskId: task.id, time },
        });
        holdNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
        if (recoveredAt !== null)
          releases.push({
            time: recoveredAt,
            worker: task.executor,
            root: task.operationId,
            batch: item.batch.id,
            station: task.station,
          });
        item.state = {
          kind: "failed",
          index: item.state.index,
          location: task.station,
        };
        continue;
      }
      if (task.kind === "native") {
        taskEvents.push({ kind: "native-settled", time, task });
        if (task.outcome !== "completed") {
          const failure = physicsOutcome(task.recording);
          if (failure.kind === "completed")
            throw new Error("Native failure lost its result");
          const recovery = recoveryFor(input.faults, task.operation.id);
          const hold: NativeHold = {
            kind: "failed",
            operation: task.operation,
            attemptId: task.operation.attempt.input.request.attemptId,
            start: task.start,
            settledTime: time,
            failure,
            recoveredAt: recovery === null ? null : time + recovery.seconds,
          };
          if (hold.recoveredAt !== null)
            releases.push({
              time: hold.recoveredAt,
              worker: null,
              root: chainRoot(task.operation),
              batch: item.batch.id,
              station: task.station,
            });
          nativeHolds.push(hold);
          holdNativeReservation(
            nativeReservations,
            reservationForChain(nativeReservations, chainRoot(task.operation)),
            time,
          );
          item.state = {
            kind: "native-held",
            index: item.state.index,
            location: task.station,
            hold,
          };
          continue;
        }
        completedTasks.add(task.operation.id);
      } else {
        taskEvents.push({
          kind: "completed",
          time,
          task,
          evidence: {
            source: "assumed-simulation",
            bakeryTaskId: task.id,
            time,
          },
        });
      }
      completedTasks.add(task.id);
      if (task.kind === "handoff" && task.phase === "transfer") {
        const next = batchStep(item.batch, item.state.index + 1);
        if (next.kind !== "native")
          throw new Error("Human placement must precede its receiving task");
        releaseNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
        reserveNativeResources(nativeReservations, next.operation, time);
      }
      if (task.kind === "handoff" && task.phase === "clear") {
        releaseNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
      }
      const index = item.state.index + 1;
      if (index === item.batch.steps.length) {
        reservations.get(task.station)!.delete(item.batch.id);
        completions.push({ batch: item.batch.id, time });
        item.state = { kind: "complete", completion: time };
      } else {
        item.state = { kind: "pending", index, location: task.station };
      }
    }
    for (const release of releases) {
      if (release.time !== time) continue;
      if (release.worker !== null)
        allocatedWorker(workers, release.worker).state = "idle";
      releaseNativeReservation(
        nativeReservations,
        reservationForChain(nativeReservations, release.root),
        time,
      );
      reservations.get(release.station)!.delete(release.batch);
    }
    const ovenOccupants = reservations.get("bake")!;
    if (oven.kind === "baking" && time >= oven.end) {
      oven = { kind: "unloading" };
    }
    if (
      oven.kind === "unloading" &&
      ovenOccupants.size === 0 &&
      !work.some(unloadingOven)
    ) {
      oven = { kind: "idle" };
    }
    const data: RunData = {
      ...model,
      taskEvents,
      nativeHolds,
      handlingFailures,
      nativeReservations,
      unresolvedWaits,
      intervals,
      cycles,
      completions,
      events: [...checkpoints].filter(beforeEnd.bind(null, time)).sort(numeric),
      end: time,
    };
    const unfinished = work.filter(notComplete).map(workId);
    if (unfinished.length === 0) {
      yield { time, events: taskEvents.slice(emittedEvents) };
      return { ...data, kind: "complete" };
    }
    if (time === horizon) {
      yield { time, events: taskEvents.slice(emittedEvents) };
      return { ...data, kind: "horizon", unfinished };
    }
    const waiting: {
      batch: string;
      location: StationId | null;
      station: StationId;
      reason: Wait["reason"];
      label: string;
    }[] = [];
    const absent = absentBaker(input.faults, time);
    const pending = work.filter(isPending).sort(priority);
    for (const item of pending) {
      if (item.state.kind !== "pending" || item.batch.release > time) {
        continue;
      }
      const index = item.state.index;
      const step = batchStep(item.batch, index);
      const destination = step.station;
      const occupied = reservations.get(destination)!;
      const stationResource = input.stationResources.find(
        hasStationId.bind(null, destination),
      );
      if (stationResource === undefined)
        throw new Error(`Missing station resource ${destination}`);
      const attended =
        step.kind === "transfer" ||
        step.kind === "handoff" ||
        (step.kind === "process" && step.attended);
      const manual = manualTaskRule(
        input.manualTasks,
        item.batch.id,
        step,
        item.state.location,
      );
      const worker = availableWorker(
        workers,
        step,
        manual?.workerId ?? null,
        absent,
        layout,
      );
      if (
        manual !== null &&
        (time < manual.earliestStartSeconds ||
          !manual.dependsOn.every(completedTasks.has.bind(completedTasks)))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: time < manual.earliestStartSeconds ? "start" : "dependency",
          label:
            time < manual.earliestStartSeconds
              ? `Earliest task start ${clock(manual.earliestStartSeconds)}`
              : `Waiting for ${manual.dependsOn.filter(notCompletedTask.bind(null, completedTasks)).join(", ")}`,
        });
        continue;
      }
      const capacity =
        stationResource.unit === "trays"
          ? Math.floor(stationResource.capacity / settings.traysPerBatch)
          : stationResource.capacity;
      if (isBakingStep(step)) {
        continue;
      }
      if (
        step.kind === "handoff" &&
        step.phase === "stage" &&
        time < step.operation.earliestStartSeconds
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "start",
          label: `Earliest staging time ${clock(step.operation.earliestStartSeconds)}`,
        });
        continue;
      }
      if (
        step.kind === "handoff" &&
        step.phase === "stage" &&
        !step.operation.dependsOn.every(completedTasks.has.bind(completedTasks))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "dependency",
          label: `Waiting for ${step.operation.dependsOn
            .filter(notCompletedTask.bind(null, completedTasks))
            .map(dependencyName.bind(null, work))
            .join(", ")}`,
        });
        continue;
      }
      if (step.kind === "native" || step.kind === "handoff") {
        const cell = input.workcells.find(
          hasCellId.bind(null, step.operation.attempt.input.bindings.cell),
        );
        if (
          cell === undefined ||
          cell.station !== destination ||
          !cell.skills.includes(
            step.operation.attempt.input.request.bakeryTaskId,
          )
        ) {
          throw new Error("Native operation has no compatible workcell");
        }
      }
      const conflict = conflictingNativeReservation(nativeReservations, step);
      if (conflict !== null) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "station",
          label: `Workcell resources reserved by ${conflict.operationId}`,
        });
        continue;
      }
      if (step.kind === "planned") {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "dependency",
          label: `Awaiting ${step.operation.predecessorId} continuation state`,
        });
        continue;
      }
      if (
        step.kind === "native" &&
        step.operation.step > 1 &&
        time < step.operation.earliestStartSeconds
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "start",
          label: `Earliest task start ${clock(step.operation.earliestStartSeconds)}; Robot cell held`,
        });
        continue;
      }
      const outage = resourceOutage(input.faults, stepResources(step), time);
      if (outage !== null) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "outage",
          label: `${outageResourceName(outage.resource)} unavailable until ${clock(outage.end)}${step.kind === "native" ? "; Robot cell held" : ""}`,
        });
        continue;
      }
      if (step.kind === "native") {
        const attempt = step.operation.attempt;
        if (attempt.kind === "awaiting-evidence") {
          const hold: NativeHold = {
            kind: "awaiting-evidence",
            operation: step.operation,
            attemptId: attempt.input.request.attemptId,
            start: time,
          };
          nativeHolds.push(hold);
          taskEvents.push({
            kind: "native-awaiting",
            time,
            operation: step.operation,
            attemptId: hold.attemptId,
          });
          item.state = {
            kind: "native-held",
            index,
            location: destination,
            hold,
          };
        } else if (
          attempt.kind === "completed" ||
          attempt.kind === "recovery-required"
        ) {
          const recording = attempt.recording;
          const task: NativeBakeryTask = {
            id: nativeTaskId(step.operation),
            kind: "native",
            batch: item.batch.id,
            station: destination,
            start: time,
            end:
              time +
              Math.max(
                0,
                physicsDuration(recording) - continuationPrefix(step.operation),
              ),
            attended: false,
            operation: { ...step.operation, attempt },
            recording,
            outcome: physicsOutcome(recording).kind,
          };
          intervals.push(task);
          taskEvents.push({ kind: "started", time, task });
          checkpoints.add(task.end);
          item.state = { kind: "running", index, task };
        } else {
          throw new Error(
            "Production requires a settled cold transfer attempt",
          );
        }
        continue;
      }
      if (
        destination === "bake" &&
        (oven.kind === "baking" ||
          oven.kind === "unloading" ||
          (oven.kind === "loading" && time >= oven.closeAt))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "cycle",
          label: "Waiting for the next oven cycle",
        });
        continue;
      }
      if (destination === "bake" && outageAt({ settings, variant }, time)) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "outage",
          label: `Oven unavailable until ${clock(settings.outageEnd * 60)}`,
        });
        continue;
      }
      if (!occupied.has(item.batch.id) && occupied.size >= capacity) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "station",
          label: `${stationLabel(destination)} full: batch ${[...occupied].join(", ")}`,
        });
        continue;
      }
      if (attended && !worker) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason:
            step.kind !== "handoff" &&
            manual?.workerId !== undefined &&
            manual.workerId === absent
              ? "outage"
              : "worker",
          label:
            step.kind === "handoff"
              ? `Assigned baker ${step.operation.workerId} is busy`
              : manual?.workerId !== null && manual?.workerId !== undefined
                ? manual.workerId === absent
                  ? `${outageResourceName(absent)} unavailable until ${clock(input.faults.outage?.end ?? time)}`
                  : `Assigned baker ${manual.workerId} is busy`
                : "All workers are busy",
        });
        continue;
      }
      let task: BakeryTask;
      if (step.kind === "handoff") {
        if (!worker) throw new Error("Staging and clearance require a worker");
        const emptyRoute = route(
          worker.position,
          station(destination, layout).handoff,
          layout,
        );
        const arrival =
          time +
          travelSeconds(
            worker.position,
            station(destination, layout).handoff,
            layout,
          );
        const id = handlingTaskId(
          item.batch.id,
          step.operation.tray,
          step.phase,
        );
        const duration =
          step.phase === "transfer"
            ? HUMAN_CELL_TRANSFER.pickupSeconds +
              HUMAN_CELL_TRANSFER.carrySeconds +
              HUMAN_CELL_TRANSFER.placementSeconds
            : coldTrayHandlingSeconds(step.phase);
        const end = arrival + duration;
        const failure = input.faults.failure;
        const failedAt =
          failure?.bakeryTaskId === id
            ? Math.min(time + failure.afterSeconds, end)
            : null;
        task = {
          id,
          kind: "handoff",
          phase: step.phase,
          operationId: chainRoot(step.operation),
          cellId: step.operation.attempt.input.bindings.cell,
          batch: item.batch.id,
          station: destination,
          start: time,
          arrival: failedAt === null ? arrival : Math.min(arrival, failedAt),
          end: failedAt ?? end,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
          outcome: failedAt === null ? "completed" : "failed",
        };
        if (step.phase === "stage") {
          reserveNativeResources(nativeReservations, step.operation, time);
        } else if (step.phase === "transfer") {
          const previous = reservationForChain(
            nativeReservations,
            chainRoot(step.operation),
          );
          releaseNativeReservation(nativeReservations, previous, time);
          nativeReservations.push({
            kind: "reserved",
            operationId: previous.operationId,
            materialId: previous.materialId,
            attemptId: step.operation.attempt.input.request.attemptId,
            resources: [
              ...new Set([
                ...previous.resources,
                ...Object.values(step.operation.material.resources),
                HUMAN_CELL_TRANSFER.buffer,
              ]),
            ],
            start: time,
          });
        }
        checkpoints.add(task.arrival);
      } else if (step.kind === "transfer") {
        if (!worker || item.state.location === null) {
          throw new Error("Transfer requires a worker and source");
        }
        const from = item.state.location;
        const emptyRoute = route(
          worker.position,
          station(from, layout).handoff,
          layout,
        );
        const loadedRoute = route(
          station(from, layout).handoff,
          station(destination, layout).handoff,
          layout,
        );
        const timing = transferTiming(settings, from, destination, layout);
        const pickupStart =
          time +
          travelSeconds(worker.position, station(from, layout).handoff, layout);
        const pickup = pickupStart + timing.pickupAfter;
        const loadedEnd = pickupStart + timing.loadedEndAfter;
        task = {
          id: `batch:${item.batch.id}:transfer:${from}:${destination}`,
          kind: "transfer",
          batch: item.batch.id,
          station: destination,
          from,
          start: time,
          pickupStart,
          pickup,
          loadedEnd,
          end: pickupStart + timing.duration,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
          route: loadedRoute,
        };
        checkpoints.add(pickup);
        checkpoints.add(loadedEnd);
      } else if (attended) {
        if (!worker) {
          throw new Error("Attended processing requires a worker");
        }
        const emptyRoute = route(
          worker.position,
          station(destination, layout).handoff,
          layout,
        );
        const arrival =
          time +
          travelSeconds(
            worker.position,
            station(destination, layout).handoff,
            layout,
          );
        task = {
          id: `batch:${item.batch.id}:process:${step.operation}`,
          kind: "process",
          batch: item.batch.id,
          station: destination,
          operation: step.operation,
          start: time,
          arrival,
          end: arrival + settings[step.operation] * 60,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
        };
        checkpoints.add(arrival);
      } else {
        task = {
          id: `batch:${item.batch.id}:process:${step.operation}`,
          kind: "process",
          batch: item.batch.id,
          station: destination,
          operation: step.operation,
          start: time,
          arrival: time,
          end: time + settings[step.operation] * 60,
          attended: false,
        };
      }
      occupied.add(item.batch.id);
      if (destination === "bake" && oven.kind === "idle") {
        oven = {
          kind: "loading",
          closeAt: time + settings.loadWindow * 60,
        };
      }
      if (task.attended) {
        allocatedWorker(workers, task.executor).state = "busy";
      }
      intervals.push(task);
      taskEvents.push({ kind: "started", time, task });
      checkpoints.add(time);
      checkpoints.add(task.end);
      item.state = { kind: "running", index, task };
    }
    const readyToBake = work.filter(readyForOven).sort(priority);
    if (
      oven.kind === "loading" &&
      readyToBake.length === ovenOccupants.size &&
      readyToBake.length > 0 &&
      !outageAt({ settings, variant }, time) &&
      (ovenOccupants.size ===
        Math.floor(settings.ovenTrays / settings.traysPerBatch) ||
        time >= oven.closeAt ||
        !work.some(beforeOven))
    ) {
      const end = time + settings.bake * 60;
      cycles.push({
        id: cycles.length + 1,
        batches: readyToBake.map(workId),
        trays: readyToBake.length * settings.traysPerBatch,
        start: time,
        end,
      });
      for (const item of readyToBake) {
        const task: Process = {
          id: `batch:${item.batch.id}:process:bake`,
          kind: "process",
          batch: item.batch.id,
          station: "bake",
          operation: "bake",
          start: time,
          arrival: time,
          end,
          attended: false,
        };
        intervals.push(task);
        taskEvents.push({ kind: "started", time, task });
        item.state = { kind: "running", index: bakingStepIndex, task };
      }
      checkpoints.add(time);
      checkpoints.add(end);
      oven = { kind: "baking", end };
    }
    for (const item of readyToBake) {
      if (item.state.kind === "pending") {
        waiting.push({
          batch: item.batch.id,
          location: "bake",
          station: "bake",
          reason: outageAt({ settings, variant }, time) ? "outage" : "cycle",
          label: outageAt({ settings, variant }, time)
            ? `Oven unavailable until ${clock(settings.outageEnd * 60)}`
            : "Loaded; waiting for the shared bake cycle",
        });
      }
    }
    yield { time, events: taskEvents.slice(emittedEvents) };
    emittedEvents = taskEvents.length;
    const future: number[] = [];
    if (oven.kind === "loading" && oven.closeAt > time) {
      future.push(oven.closeAt);
    }
    for (const item of work) {
      if (item.batch.release > time) {
        future.push(item.batch.release);
      }
      if (item.state.kind === "running") {
        const task = item.state.task;
        future.push(task.end);
        if (task.kind === "transfer" && task.pickup > time) {
          future.push(task.pickup);
        }
      }
      if (item.state.kind === "pending") {
        const step = batchStep(item.batch, item.state.index);
        const manual = manualTaskRule(
          input.manualTasks,
          item.batch.id,
          step,
          item.state.location,
        );
        if (manual !== null && manual.earliestStartSeconds > time)
          future.push(manual.earliestStartSeconds);
        if (
          ((step.kind === "handoff" && step.phase === "stage") ||
            (step.kind === "native" && step.operation.step > 1)) &&
          step.operation.earliestStartSeconds > time
        )
          future.push(step.operation.earliestStartSeconds);
      }
    }
    for (const release of releases)
      if (release.time > time) future.push(release.time);
    const outage = input.faults.outage;
    if (outage !== null)
      for (const boundary of [outage.start, outage.end])
        if (boundary > time) future.push(boundary);
    if (variant === "outage") {
      for (const boundary of [
        settings.outageStart * 60,
        settings.outageEnd * 60,
      ]) {
        if (boundary > time) {
          future.push(boundary);
        }
      }
    }
    if (future.length === 0) {
      for (const entry of waiting) {
        unresolvedWaits.push({
          batch: entry.batch,
          location: entry.location,
          station: entry.station,
          reason: entry.reason,
          label: entry.label,
          time,
        });
      }
      return { ...data, kind: "blocked", unfinished };
    }
    const next = Math.min(horizon, ...future);
    for (const entry of waiting) {
      intervals.push({
        kind: "wait",
        batch: entry.batch,
        station: entry.station,
        start: time,
        end: next,
        location: entry.location,
        reason: entry.reason,
        label: entry.label,
      });
    }
    checkpoints.add(next);
    time = next;
  }
}

function workerFromResource(resource: HumanResource): Worker {
  return { resource, position: resource.start, state: "idle" };
}

function workerAvailableFor(step: Step, worker: Worker): boolean {
  if (worker.state !== "idle") return false;
  if (step.kind === "handoff" && worker.resource.id !== step.operation.workerId)
    return false;
  if (step.kind === "transfer" || step.kind === "handoff") {
    return worker.resource.capabilities.includes("tray-handling");
  }
  return worker.resource.capabilities.includes("manual-processing");
}

function manualTaskRule(
  rules: readonly ProductionManualTask[],
  batchId: string,
  step: Step,
  location: StationId | null,
): ProductionManualTask | null {
  let id: string;
  switch (step.kind) {
    case "process":
      id = `batch:${batchId}:process:${step.operation}`;
      break;
    case "transfer":
      id = `batch:${batchId}:transfer:${location}:${step.station}`;
      break;
    case "handoff":
    case "native":
    case "planned":
      return null;
    default:
      return assertNever(step, "Unexpected simulator state");
  }
  return rules.find(hasManualTaskId.bind(null, id)) ?? null;
}
function hasManualTaskId(id: string, task: ProductionManualTask): boolean {
  return task.bakeryTaskId === id;
}
function availableWorker(
  workers: readonly Worker[],
  step: Step,
  assignedWorker: HumanId | null,
  absent: HumanId | null,
  layout: ResolvedScheduleLayout | undefined,
): Worker | undefined {
  const present = workers.filter(notWorker.bind(null, absent));
  if (step.kind === "handoff") {
    const assigned = present.find(
      hasWorkerId.bind(null, step.operation.workerId),
    );
    return assigned !== undefined && workerAvailableFor(step, assigned)
      ? assigned
      : undefined;
  }
  if (assignedWorker !== null) {
    const worker = present.find(hasWorkerId.bind(null, assignedWorker));
    return worker !== undefined && workerAvailableFor(step, worker)
      ? worker
      : undefined;
  }
  const candidates = present.filter(workerAvailableFor.bind(null, step));
  if (candidates.length <= 1 || layout === undefined) {
    return candidates[0];
  }
  const targetStation: StationId | null =
    step.kind === "process" || step.kind === "transfer" ? step.station : null;
  if (targetStation === null) {
    return candidates[0];
  }
  const targetZone = stationZone(targetStation);
  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const profile = staffRoleProfileFor(cand.resource.id);
    let score = 0;
    if (profile.zone === targetZone) score += 100;
    if (profile.preferredStations.includes(targetStation)) score += 50;
    const targetPt = station(targetStation, layout).handoff;
    const dist = Math.hypot(
      cand.position[0] - targetPt[0],
      cand.position[1] - targetPt[1],
    );
    score -= dist * 4;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}
function notWorker(id: HumanId | null, worker: Worker): boolean {
  return worker.resource.id !== id;
}

// Staging takes the baker and the chain's cell resources; clearance needs only
// the baker. A native step needs each resource its request binds.
function stepResources(step: Step): readonly OutageResource[] {
  switch (step.kind) {
    case "handoff":
      return step.phase !== "clear"
        ? [
            step.operation.workerId,
            ...Object.values(step.operation.material.resources),
          ]
        : [step.operation.workerId];
    case "native":
      return workcellResources(step.operation.attempt.input).map(resourceId);
    case "planned":
    case "transfer":
    case "process":
      return [];
    default:
      return assertNever(step, "Unexpected simulator state");
  }
}
function resourceId(resource: WorkcellResource): WorkcellResourceId {
  return resource.id;
}

// Names a prerequisite; one on a failed tray will not finish without recovery.
function dependencyName(work: readonly Work[], id: string): string {
  const batch = id.split(":")[1];
  const item = work.find(hasBatchId.bind(null, batch));
  return item !== undefined && failedWork(item)
    ? `${id} (its tray failed)`
    : id;
}
function hasBatchId(id: string | undefined, item: Work): boolean {
  return item.batch.id === id;
}
function failedWork(item: Work): boolean {
  return (
    item.state.kind === "failed" ||
    (item.state.kind === "native-held" && item.state.hold.kind === "failed")
  );
}

function notCompletedTask(completed: ReadonlySet<string>, id: string): boolean {
  return !completed.has(id);
}

// A chain owns its whole resource set until clearance or explicit recovery.
// Keeping ownership in the reservation history avoids a separate global cell lock.
function reservationForChain(
  reservations: readonly NativeReservation[],
  root: string,
): Exclude<NativeReservation, { kind: "released" }> {
  for (const reservation of reservations)
    if (reservation.kind !== "released" && reservation.operationId === root)
      return reservation;
  throw new Error(`Missing workcell reservation for ${root}`);
}

function conflictingNativeReservation(
  reservations: readonly NativeReservation[],
  step: Step,
): Exclude<NativeReservation, { kind: "released" }> | null {
  if (
    step.kind !== "native" &&
    step.kind !== "handoff" &&
    step.kind !== "planned"
  )
    return null;
  const required: NativeReservation["resources"] =
    step.kind === "handoff" && step.phase === "transfer"
      ? [
          ...Object.values(step.operation.material.resources),
          HUMAN_CELL_TRANSFER.buffer,
        ]
      : Object.values(step.operation.material.resources);
  const root = chainRoot(step.operation);
  for (const reservation of reservations) {
    if (reservation.kind === "released" || reservation.operationId === root)
      continue;
    for (const resource of required)
      if (reservation.resources.includes(resource)) return reservation;
  }
  return null;
}

function reserveNativeResources(
  reservations: NativeReservation[],
  operation: ProductionWorkcell,
  time: number,
): void {
  const binding = operation.material.resources;
  const reservation: NativeReservation = {
    kind: "reserved",
    materialId: operation.material.materialId,
    operationId: chainRoot(operation),
    attemptId: operation.attempt.input.request.attemptId,
    resources: [
      binding.arm,
      binding.tool,
      binding.tray,
      binding.source,
      binding.destination,
      binding.cell,
    ],
    start: time,
  };
  reservations.push(reservation);
}

function replaceNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  next: NativeReservation,
): void {
  const index = reservations.indexOf(previous);
  if (index < 0) throw new Error("Missing native reservation");
  reservations[index] = next;
}

function holdNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  time: number,
): void {
  const next: NativeReservation = {
    kind: "held",
    operationId: previous.operationId,
    materialId: previous.materialId,
    attemptId: previous.attemptId,
    resources: previous.resources,
    start: previous.start,
    heldAt: time,
  };
  replaceNativeReservation(reservations, previous, next);
}

function releaseNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  time: number,
): void {
  replaceNativeReservation(reservations, previous, {
    kind: "released",
    operationId: previous.operationId,
    materialId: previous.materialId,
    attemptId: previous.attemptId,
    resources: previous.resources,
    start: previous.start,
    end: time,
  });
}

function allocatedWorker(workers: readonly Worker[], id: HumanId): Worker {
  const worker = workers.find(hasWorkerId.bind(null, id));
  if (worker === undefined) throw new Error(`Missing allocated worker ${id}`);
  return worker;
}

function hasWorkerId(id: HumanId, worker: Worker): boolean {
  return worker.resource.id === id;
}

function beforeEnd(end: number, time: number): boolean {
  return time <= end;
}

function unloadingOven(item: Work): boolean {
  return (
    item.state.kind === "running" &&
    item.state.task.kind === "transfer" &&
    item.state.task.from === "bake"
  );
}

function readyForOven(item: Work): boolean {
  return (
    item.state.kind === "pending" &&
    isBakingStep(batchStep(item.batch, item.state.index))
  );
}

function batchStep(batch: BatchProcedure, index: number): Step {
  const step = batch.steps[index];
  if (step === undefined)
    throw new Error(`Missing step ${index} for batch ${batch.id}`);
  return step;
}

// Robot-only rehearsal trays never bake; only a batch with baking ahead waits.
function beforeOven(item: Work): boolean {
  return (
    item.state.kind !== "complete" &&
    item.batch.steps.slice(item.state.index + 1).some(isBakingStep)
  );
}

function numeric(a: number, b: number): number {
  return a - b;
}

function notComplete(item: Work): boolean {
  return item.state.kind !== "complete";
}

function workId(item: Work): string {
  return item.batch.id;
}

function isPending(item: Work): boolean {
  return item.state.kind === "pending";
}

function priority(a: Work, b: Work): number {
  return (
    a.batch.deadline - b.batch.deadline ||
    a.batch.release - b.batch.release ||
    compareCodePoints(a.batch.id, b.batch.id)
  );
}
