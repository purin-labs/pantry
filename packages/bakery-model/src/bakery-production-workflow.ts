import { financierOperations, type Settings } from "./bakery.ts";
import type {
  ProductionAssignment,
  ProductionRoute,
} from "./bakery-production-scenario.ts";
import { compareCodePoints, isString } from "@purin-labs/std";

export type ProductionManualTask = Readonly<{
  bakeryTaskId: string;
  workerId: `human-${number}` | null;
  dependsOn: readonly string[];
  earliestStartSeconds: number;
}>;

export type ProductionTaskChoice = Readonly<{
  id: string;
  label: string;
  kind: "manual" | "process" | "native" | "handoff";
  predecessors: readonly string[];
}>;

// This graph includes the scheduler's fixed material order, including cell clearance.
export function productionTaskChoices(
  settings: Settings,
  assignments: readonly Pick<ProductionAssignment, "batchId" | "tray">[],
  route: ProductionRoute["route"],
): readonly ProductionTaskChoice[] {
  const tasks: ProductionTaskChoice[] = [];
  for (let batch = 0; batch < settings.batchCount; batch++) {
    const batchId = String.fromCharCode(65 + batch);
    let previous: string | null = null;
    let station: string | null = null;
    for (const operation of financierOperations) {
      if (station !== null && station !== operation.station) {
        const id = `batch:${batchId}:transfer:${station}:${operation.station}`;
        tasks.push({
          id,
          label: transferLabel(batchId, station, operation.station, route),
          kind: "manual",
          predecessors: previous === null ? [] : [previous],
        });
        previous = id;
        if (route === "oven-rack" && operation.station === "bake")
          previous = addOvenTask(
            tasks,
            batchId,
            "oven-load",
            "Load oven",
            previous,
          );
      }
      const id = `batch:${batchId}:process:${operation.operation}`;
      tasks.push({
        id,
        label: `${batchId} · ${operation.operation === "finishCooling" ? "Cool before packing" : operation.operation}`,
        kind: operation.attended ? "manual" : "process",
        predecessors: previous === null ? [] : [previous],
      });
      previous = id;
      station = operation.station;
      if (route === "oven-rack" && operation.operation === "bake") {
        previous = addOvenTask(
          tasks,
          batchId,
          "oven-retrieve",
          "Retrieve from oven",
          previous,
        );
        previous = addOvenTask(
          tasks,
          batchId,
          "oven-rack",
          "Place on oven rack",
          previous,
        );
      }
      if (operation.operation !== "cool") continue;
      const trays = assignments
        .filter(inBatch.bind(null, batchId))
        .sort(byTray);
      for (const tray of trays) {
        for (const phase of ["stage", "native", "clear"] as const) {
          const bakeryTaskId =
            phase === "native"
              ? `batch:${batchId}:native:${tray.tray}`
              : `batch:${batchId}:handoff:${tray.tray}-${phase}`;
          tasks.push({
            id: bakeryTaskId,
            label: `${batchId} · tray ${tray.tray} · ${phase}`,
            kind: phase === "native" ? "native" : "handoff",
            predecessors: [previous],
          });
          previous = bakeryTaskId;
        }
      }
    }
  }
  return tasks;
}

function addOvenTask(
  tasks: ProductionTaskChoice[],
  batch: string,
  key: "oven-load" | "oven-retrieve" | "oven-rack",
  label: string,
  previous: string,
): string {
  const id = `batch:${batch}:native:${key}`;
  tasks.push({
    id,
    label: `${batch} · ${label}`,
    kind: "native",
    predecessors: [previous],
  });
  return id;
}

function transferLabel(
  batch: string,
  from: string,
  to: string,
  route: ProductionRoute["route"],
): string {
  if (route === "oven-rack" && to === "bake")
    return `${batch} · Stage oven source table`;
  if (route === "oven-rack" && from === "bake")
    return `${batch} · Clear oven rack to cooling`;
  return `${batch} · ${from} → ${to}`;
}

function inBatch(
  batchId: string,
  assignment: Pick<ProductionAssignment, "batchId" | "tray">,
): boolean {
  return assignment.batchId === batchId;
}
function byTray(
  left: Pick<ProductionAssignment, "tray">,
  right: Pick<ProductionAssignment, "tray">,
): number {
  return left.tray - right.tray;
}

export function parseProductionManualTasks(
  raw: unknown,
  settings: Settings,
  assignments: readonly ProductionAssignment[],
  route: ProductionRoute["route"],
): readonly ProductionManualTask[] | null {
  if (!Array.isArray(raw) || raw.length > 60) return null;
  const choices = productionTaskChoices(settings, assignments, route);
  const result: ProductionManualTask[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "bakeryTaskId,dependsOn,earliestStartSeconds,workerId" ||
      typeof value.bakeryTaskId !== "string" ||
      ids.has(value.bakeryTaskId) ||
      !choices.some(isManualTask.bind(null, value.bakeryTaskId)) ||
      !Array.isArray(value.dependsOn) ||
      !value.dependsOn.every(isString) ||
      !Number.isInteger(value.earliestStartSeconds) ||
      value.earliestStartSeconds < 0 ||
      value.earliestStartSeconds >= settings.horizonMinutes * 60 ||
      (value.workerId !== null &&
        (typeof value.workerId !== "string" ||
          !/^human-[1-3]$/.test(value.workerId) ||
          Number(value.workerId.slice(6)) > settings.workerCount))
    )
      return null;
    ids.add(value.bakeryTaskId);
    result.push(
      Object.freeze({
        bakeryTaskId: value.bakeryTaskId,
        workerId:
          value.workerId === null
            ? null
            : `human-${Number(value.workerId.slice(6))}`,
        dependsOn: Object.freeze([...value.dependsOn].sort()),
        earliestStartSeconds: value.earliestStartSeconds,
      }),
    );
  }
  return Object.freeze(result.sort(compareManualTask));
}
function isManualTask(id: string, task: ProductionTaskChoice): boolean {
  return task.id === id && task.kind === "manual";
}
function compareManualTask(
  left: ProductionManualTask,
  right: ProductionManualTask,
): number {
  return compareCodePoints(left.bakeryTaskId, right.bakeryTaskId);
}

export function validProductionWorkflow(
  settings: Settings,
  assignments: readonly ProductionAssignment[],
  manualTasks: readonly ProductionManualTask[],
  route: ProductionRoute["route"],
): boolean {
  const choices = productionTaskChoices(settings, assignments, route);
  const graph = new Map<string, Set<string>>();
  for (const task of choices) graph.set(task.id, new Set(task.predecessors));
  for (const task of manualTasks) {
    if (!addDependencies(graph, task.bakeryTaskId, task.dependsOn))
      return false;
  }
  for (const assignment of assignments) {
    if (
      !addDependencies(
        graph,
        `batch:${assignment.batchId}:handoff:${assignment.tray}-stage`,
        assignment.dependsOn,
      )
    )
      return false;
  }
  const completed = new Set<string>();
  while (completed.size < graph.size) {
    const before = completed.size;
    for (const [id, predecessors] of graph) {
      if ([...predecessors].every(completed.has.bind(completed)))
        completed.add(id);
    }
    if (before === completed.size) return false;
  }
  return true;
}
function addDependencies(
  graph: Map<string, Set<string>>,
  id: string,
  dependencies: readonly string[],
): boolean {
  const target = graph.get(id);
  if (
    target === undefined ||
    new Set(dependencies).size !== dependencies.length
  )
    return false;
  for (const dependency of dependencies) {
    if (!graph.has(dependency) || id === dependency) return false;
    target.add(dependency);
  }
  return true;
}
