import {
  parseProductionManualTasks,
  validProductionWorkflow,
  type ProductionManualTask,
} from "./bakery-production-workflow.ts";
export {
  productionTaskChoices,
  parseProductionManualTasks,
  validProductionWorkflow,
  type ProductionManualTask,
  type ProductionTaskChoice,
} from "./bakery-production-workflow.ts";
import {
  bakeryFingerprint,
  fields,
  parseSettings,
  type Settings,
} from "./bakery.ts";
import {
  parsePersistentCell,
  type PersistentOvenCell,
} from "./bakery-physics.ts";
import { isCustomCommerceEntity } from "@purin-labs/contracts";

const validated: unique symbol = Symbol("validated bakery production scenario");

export type ProductionAssignment = Readonly<{
  batchId: string;
  tray: number;
  workerId: `human-${number}`;
  dependsOn: readonly string[];
  earliestStartSeconds: number;
}>;
export type ProductionCanvasPosition = Readonly<{ x: number; y: number }>;
export type ProductionPresentation = Readonly<
  Record<string, ProductionCanvasPosition>
>;

export type ProductionRoute =
  | Readonly<{ route: "cold-racking"; cell?: never; executionBundleId?: never }>
  | Readonly<{
      route: "oven-rack";
      cell: PersistentOvenCell;
      executionBundleId: string;
    }>;

type ScenarioFields = Readonly<{
  [validated]: true;
  id: string;
  name: string;
  note: string;
  procedureId: string;
  sourceFingerprint: string;
  definitionFingerprint: string;
  settings: Settings;
  variant: "normal" | "outage";
  manualTasks: readonly ProductionManualTask[];
  presentation: ProductionPresentation;
}>;

export type ProductionScenario = ScenarioFields &
  (
    | Readonly<{
        route: "cold-racking";
        cell?: never;
        executionBundleId?: never;
        assignments: readonly ProductionAssignment[];
      }>
    | Readonly<{
        route: "oven-rack";
        cell: PersistentOvenCell;
        executionBundleId: string;
        assignments: readonly [];
      }>
  );

/** The physical route replaces the procedure's declared oven with its one-slot fixture. */
export function productionSettingsMatchProcedure(
  definition: ProductionScenario,
  source: Settings,
): boolean {
  for (const field of fields) {
    const expected =
      definition.route === "oven-rack" && field.key === "ovenTrays"
        ? 1
        : source[field.key];
    if (definition.settings[field.key] !== expected) return false;
  }
  return true;
}

export function productionInitialPresentation(
  assignments: readonly ProductionAssignment[],
): ProductionPresentation {
  const positions: Record<string, ProductionCanvasPosition> = {};
  for (const [index, assignment] of assignments.entries()) {
    positions[productionAssignmentId(assignment)] = {
      x: 24 + (index % 4) * 190,
      y: 24 + Math.floor(index / 4) * 145,
    };
  }
  return positions;
}

export function productionAssignmentId(
  assignment: Pick<ProductionAssignment, "batchId" | "tray">,
): string {
  return `batch:${assignment.batchId}:native:${assignment.tray}`;
}

export async function productionDefinitionFingerprint(
  sourceFingerprint: string,
  settings: Settings,
  variant: ProductionScenario["variant"],
  assignments: readonly ProductionAssignment[],
  manualTasks: readonly ProductionManualTask[],
  route: ProductionRoute,
): Promise<string> {
  const content = {
    sourceFingerprint,
    ...(route.route === "oven-rack"
      ? {
          route: route.route,
          cell: route.cell,
          executionBundleId: route.executionBundleId,
        }
      : {}),
    ...(manualTasks.length === 0 ? {} : { manualTasks }),
    settings,
    variant,
    assignments: [...assignments]
      .sort(compareAssignment)
      .map(assignmentFingerprint),
    handling:
      route.route === "oven-rack"
        ? "persistent-oven-rack/1"
        : {
            stagingSeconds: 30,
            clearanceSeconds: 15,
            material: "cold-proxy",
          },
  };
  return bakeryFingerprint(
    route.route === "oven-rack"
      ? canonicalJson(content)
      : JSON.stringify(content),
  );
}

function assignmentFingerprint(assignment: ProductionAssignment): unknown {
  return {
    batchId: assignment.batchId,
    tray: assignment.tray,
    workerId: assignment.workerId,
    dependsOn: [...assignment.dependsOn].sort(),
    ...(assignment.earliestStartSeconds === 0
      ? {}
      : { earliestStartSeconds: assignment.earliestStartSeconds }),
  };
}

export function parseProductionScenario(
  value: unknown,
): ProductionScenario | null {
  if (!isRecord(value)) return null;
  const route = value.route === undefined ? "cold-racking" : value.route;
  if (route !== "cold-racking" && route !== "oven-rack") return null;
  const routeFields = value.route === undefined ? [] : ["route"];
  if (route === "oven-rack") routeFields.push("cell", "executionBundleId");
  if (
    !hasExactKeys(value, [
      "id",
      "name",
      "note",
      "procedureId",
      "sourceFingerprint",
      "definitionFingerprint",
      "settings",
      "variant",
      "assignments",
      "presentation",
      "manualTasks",
      ...routeFields,
    ]) &&
    !hasExactKeys(value, [
      "id",
      "name",
      "note",
      "procedureId",
      "sourceFingerprint",
      "definitionFingerprint",
      "settings",
      "variant",
      "assignments",
      "presentation",
      ...routeFields,
    ]) &&
    !hasExactKeys(value, [
      "id",
      "name",
      "note",
      "procedureId",
      "sourceFingerprint",
      "definitionFingerprint",
      "settings",
      "variant",
      "assignments",
      ...routeFields,
    ])
  )
    return null;
  if (
    !text(value.id, 80) ||
    !text(value.name, 80) ||
    !text(value.note, 2000) ||
    !text(value.procedureId, 128) ||
    !isSha256Hex(value.sourceFingerprint) ||
    !isSha256Hex(value.definitionFingerprint) ||
    !isRecord(value.settings) ||
    (value.variant !== "normal" && value.variant !== "outage") ||
    !Array.isArray(value.assignments) ||
    (route === "cold-racking" && value.assignments.length < 1) ||
    value.assignments.length > 16
  )
    return null;
  const rawSettings = value.settings;
  if (
    Object.keys(rawSettings).length !== fields.length ||
    fields.some((field) => typeof rawSettings[field.key] !== "number")
  )
    return null;
  const settings = parseSettings(rawSettings);
  if (settings.kind !== "valid") return null;
  if (
    route === "oven-rack" &&
    (value.assignments.length !== 0 ||
      settings.settings.traysPerBatch !== 1 ||
      settings.settings.ovenTrays !== 1)
  )
    return null;
  const assignments: ProductionAssignment[] = [];
  const ids = new Set<string>();
  for (const raw of value.assignments) {
    if (
      !isRecord(raw) ||
      (!hasExactKeys(raw, ["batchId", "tray", "workerId", "dependsOn"]) &&
        !hasExactKeys(raw, [
          "batchId",
          "tray",
          "workerId",
          "dependsOn",
          "earliestStartSeconds",
        ]))
    )
      return null;
    const earliestStartSeconds = Object.hasOwn(raw, "earliestStartSeconds")
      ? raw.earliestStartSeconds
      : 0;
    if (
      typeof raw.batchId !== "string" ||
      raw.batchId.length !== 1 ||
      raw.batchId.charCodeAt(0) < 65 ||
      raw.batchId.charCodeAt(0) >= 65 + settings.settings.batchCount ||
      typeof raw.tray !== "number" ||
      !Number.isInteger(raw.tray) ||
      raw.tray < 1 ||
      raw.tray > settings.settings.traysPerBatch ||
      typeof raw.workerId !== "string" ||
      !/^human-[1-9][0-9]*$/.test(raw.workerId) ||
      Number(raw.workerId.slice(6)) > settings.settings.workerCount ||
      !Array.isArray(raw.dependsOn) ||
      raw.dependsOn.length > 120 ||
      !raw.dependsOn.every(isString) ||
      typeof earliestStartSeconds !== "number" ||
      !Number.isInteger(earliestStartSeconds) ||
      earliestStartSeconds < 0 ||
      earliestStartSeconds >= settings.settings.horizonMinutes * 60
    )
      return null;
    const assignment: ProductionAssignment = {
      batchId: raw.batchId,
      tray: raw.tray,
      workerId: `human-${Number(raw.workerId.slice(6))}`,
      dependsOn: Object.freeze([...raw.dependsOn].sort()),
      earliestStartSeconds,
    };
    const id = productionAssignmentId(assignment);
    if (
      ids.has(id) ||
      new Set(assignment.dependsOn).size !== assignment.dependsOn.length
    )
      return null;
    ids.add(id);
    assignments.push(assignment);
  }
  assignments.sort(compareAssignment);
  const manualTasks = parseProductionManualTasks(
    value.manualTasks === undefined ? [] : value.manualTasks,
    settings.settings,
    assignments,
    route,
  );
  if (
    manualTasks === null ||
    !validProductionWorkflow(settings.settings, assignments, manualTasks, route)
  )
    return null;
  const presentation = parseProductionPresentation(
    value.presentation,
    assignments,
  );
  if (presentation === null) return null;
  if (route === "oven-rack") {
    const cell = parsePersistentCell(value.cell);
    if (
      cell === null ||
      cell.fixture !== "persistent-oven-rack/1" ||
      !isSha256Hex(value.executionBundleId)
    )
      return null;
    return Object.freeze<ProductionScenario>({
      [validated]: true,
      id: value.id,
      name: value.name,
      note: value.note,
      procedureId: value.procedureId,
      sourceFingerprint: value.sourceFingerprint,
      definitionFingerprint: value.definitionFingerprint,
      settings: settings.settings,
      variant: value.variant,
      route: "oven-rack",
      cell,
      executionBundleId: value.executionBundleId,
      assignments: [],
      manualTasks,
      presentation,
    });
  }
  return Object.freeze<ProductionScenario>({
    [validated]: true,
    id: value.id,
    name: value.name,
    note: value.note,
    procedureId: value.procedureId,
    sourceFingerprint: value.sourceFingerprint,
    definitionFingerprint: value.definitionFingerprint,
    settings: settings.settings,
    variant: value.variant,
    route: "cold-racking",
    assignments: Object.freeze(assignments),
    manualTasks,
    presentation,
  });
}

export function parseProductionPresentation(
  value: unknown,
  assignments: readonly ProductionAssignment[],
): ProductionPresentation | null {
  if (value === undefined) return productionInitialPresentation(assignments);
  if (!isRecord(value) || Object.keys(value).length !== assignments.length)
    return null;
  const positions: Record<string, ProductionCanvasPosition> = {};
  for (const assignment of assignments) {
    const id = productionAssignmentId(assignment);
    const point = value[id];
    if (
      !isRecord(point) ||
      !hasExactKeys(point, ["x", "y"]) ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.x > 600 ||
      point.y < 0 ||
      point.y > 500
    )
      return null;
    positions[id] = { x: point.x, y: point.y };
  }
  return Object.freeze(positions);
}

function compareAssignment(
  left: ProductionAssignment,
  right: ProductionAssignment,
): number {
  return left.batchId.localeCompare(right.batchId) || left.tray - right.tray;
}

function text(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= length &&
    value.trim() === value
  );
}

import type {
  CommerceGraphQueryResult,
  CustomCommerceEntity,
} from "@purin-labs/contracts";
import {
  canonicalJson,
  hasExactKeys,
  isRecord,
  isSha256Hex,
  isString,
  parseJsonOrNull,
} from "@purin-labs/std";

export function productionScenarioFromGraph(
  graph: CommerceGraphQueryResult,
  scenarioId: string,
): ProductionScenario | null {
  const parent = graph.entities.find(
    matchesScenarioEntity.bind(null, scenarioId),
  );
  if (
    parent === undefined ||
    !("typeRevision" in parent) ||
    (parent.typeRevision !== 4 && parent.typeRevision !== 5)
  )
    return null;
  const procedureLinks = graph.relationships.filter(
    isScenarioProcedure.bind(null, scenarioId),
  );
  const procedureLink = procedureLinks[0];
  if (
    procedureLinks.length !== 1 ||
    procedureLink === undefined ||
    procedureLink.target.origin !== "custom"
  )
    return null;
  const members = graph.relationships.filter(
    isScenarioTask.bind(null, scenarioId),
  );
  if (members.length > 16) return null;
  const assignments: {
    batchId: string;
    tray: number;
    workerId: `human-${number}`;
    dependsOn: string[];
    earliestStartSeconds: number;
  }[] = [];
  const ids = new Map<string, string>();
  for (const member of members) {
    const ref = member.target;
    if (ref.origin !== "custom" || ref.typeId !== "bakery_production_task")
      return null;
    const task = graph.entities.find(
      matchesTaskEntity.bind(null, ref.entityId),
    );
    if (
      task === undefined ||
      !("typeRevision" in task) ||
      (task.typeRevision !== 1 && task.typeRevision !== 2)
    )
      return null;
    const attributes = attributesOf(task);
    if (
      typeof attributes.batch_index !== "number" ||
      typeof attributes.tray !== "number" ||
      typeof attributes.worker_index !== "number" ||
      (task.typeRevision === 2 &&
        typeof attributes.earliest_start_seconds !== "number")
    )
      return null;
    const assignment = {
      batchId: String.fromCharCode(65 + attributes.batch_index),
      tray: attributes.tray,
      workerId: `human-${attributes.worker_index}` as const,
      dependsOn: [] as string[],
      earliestStartSeconds:
        typeof attributes.earliest_start_seconds === "number"
          ? attributes.earliest_start_seconds
          : 0,
    };
    ids.set(ref.entityId, productionAssignmentId(assignment));
    assignments.push(assignment);
  }
  for (const member of members) {
    const ref = member.target;
    if (ref.origin !== "custom") return null;
    const id = ids.get(ref.entityId);
    const assignment = assignments.find(matchesAssignmentId.bind(null, id));
    if (assignment === undefined) return null;
    const dependencies = graph.relationships.filter(
      isTaskDependency.bind(null, ref.entityId),
    );
    for (const dependency of dependencies) {
      if (dependency.target.origin !== "custom") return null;
      const predecessor = ids.get(dependency.target.entityId);
      if (predecessor === undefined) return null;
      assignment.dependsOn.push(predecessor);
    }
  }
  const parentAttributes = attributesOf(parent);
  let route: unknown = { route: "cold-racking" };
  if (parent.typeRevision === 5) {
    const encoded = parentAttributes.execution_route;
    if (typeof encoded !== "string") return null;
    route = parseJsonOrNull(encoded);
  }
  if (
    !isRecord(route) ||
    (route.route !== "cold-racking" && route.route !== "oven-rack")
  )
    return null;
  if (
    !hasExactKeys(
      route,
      route.route === "cold-racking"
        ? ["route"]
        : ["route", "cell", "executionBundleId"],
    )
  )
    return null;
  if (
    typeof parentAttributes.task_dependencies !== "string" ||
    typeof parentAttributes.manual_tasks !== "string" ||
    typeof parentAttributes.canvas_positions !== "string"
  )
    return null;
  const dependencies = parseJsonOrNull(parentAttributes.task_dependencies);
  if (
    !isRecord(dependencies) ||
    Object.keys(dependencies).length !== assignments.length
  )
    return null;
  for (const assignment of assignments) {
    const value = dependencies[productionAssignmentId(assignment)];
    if (!Array.isArray(value) || !value.every(isString)) return null;
    assignment.dependsOn = value;
  }
  const settings: Record<string, unknown> = {};
  for (const field of fields) settings[field.key] = parentAttributes[field.key];
  return parseProductionScenario({
    id: parent.reference.entityId,
    name: parent.displayName,
    note: parentAttributes.timing_note,
    procedureId: procedureLink.target.entityId,
    sourceFingerprint: parentAttributes.source_fingerprint,
    definitionFingerprint: parentAttributes.definition_fingerprint,
    settings,
    variant: parentAttributes.variant,
    assignments,
    manualTasks: parseJsonOrNull(parentAttributes.manual_tasks),
    presentation: parseJsonOrNull(parentAttributes.canvas_positions),
    ...route,
  });
}

function matchesAssignmentId(
  id: string | undefined,
  assignment: ProductionAssignment,
): boolean {
  return id !== undefined && productionAssignmentId(assignment) === id;
}
function matchesScenarioEntity(
  id: string,
  entity: CommerceGraphQueryResult["entities"][number],
): boolean {
  return (
    isCustomCommerceEntity(entity) &&
    entity.reference.typeId === "bakery_production_scenario" &&
    entity.reference.entityId === id &&
    entity.state.state === "active"
  );
}
function matchesTaskEntity(
  id: string,
  entity: CommerceGraphQueryResult["entities"][number],
): boolean {
  return (
    isCustomCommerceEntity(entity) &&
    entity.reference.typeId === "bakery_production_task" &&
    entity.reference.entityId === id &&
    entity.state.state === "active"
  );
}
function isScenarioProcedure(
  id: string,
  edge: CommerceGraphQueryResult["relationships"][number],
): boolean {
  return (
    edge.origin === "custom" &&
    edge.definition.definitionId === "bakery_production_procedure" &&
    edge.source.origin === "custom" &&
    edge.source.entityId === id &&
    edge.target.origin === "custom" &&
    edge.target.typeId === "bakery_procedure"
  );
}
function isScenarioTask(
  id: string,
  edge: CommerceGraphQueryResult["relationships"][number],
): boolean {
  return (
    edge.origin === "custom" &&
    edge.definition.definitionId === "bakery_production_task_member" &&
    edge.source.origin === "custom" &&
    edge.source.entityId === id
  );
}
function isTaskDependency(
  id: string,
  edge: CommerceGraphQueryResult["relationships"][number],
): boolean {
  return (
    edge.origin === "custom" &&
    edge.definition.definitionId === "bakery_production_task_after" &&
    edge.source.origin === "custom" &&
    edge.source.entityId === id
  );
}
function attributesOf(entity: CustomCommerceEntity): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of entity.attributes) {
    if (Object.hasOwn(result, attribute.attributeId)) return {};
    if (attribute.value.kind === "integer")
      result[attribute.attributeId] = Number(attribute.value.value);
    else if (
      attribute.value.kind === "short_text" ||
      attribute.value.kind === "long_text"
    )
      result[attribute.attributeId] = attribute.value.value;
  }
  return result;
}
