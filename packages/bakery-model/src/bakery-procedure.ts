import {
  bakeryProcedureKey,
  financierOperations,
  parseSettings,
  type Operation,
  type Settings,
  type SettingsField,
  type SettingsResult,
  type StationId,
} from "./bakery.ts";
import type {
  CommerceEntityRef,
  CommerceEntityRevision,
  CommerceGraphQueryResult,
  CommerceSnapshotRevision,
  CustomCommerceEntity,
  CustomCommerceEntityRef,
  CustomCommerceRelationship,
  CustomCommerceRelationshipRef,
} from "@purin-labs/commerce-contracts";
import type { CommerceGraphQuery } from "@purin-labs/commerce-contracts";
import { isCustomCommerceEntity } from "@purin-labs/commerce-contracts";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";

export async function readBakeryProcedure(
  readGraph: (query: CommerceGraphQuery) => Promise<CommerceGraphQueryResult>,
  reference: CustomCommerceEntityRef,
  assumptions: Settings,
): Promise<ProcedureResult> {
  const result = await readBakeryProcedureGraph(readGraph, reference);
  return result.kind === "invalid"
    ? result
    : compileBakeryGraph(result.graph, reference, assumptions);
}

async function readBakeryProcedureGraph(
  readGraph: (query: CommerceGraphQuery) => Promise<CommerceGraphQueryResult>,
  reference: CustomCommerceEntityRef,
): Promise<
  | Readonly<{ kind: "ready"; graph: CommerceGraphQueryResult }>
  | Readonly<{ kind: "invalid"; message: string }>
> {
  const membership = await readGraph(
    parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [reference],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "bakery_procedure_operation",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    }),
  );
  const seeds: CustomCommerceEntityRef[] = [];
  for (const entity of membership.entities) {
    if (
      entity.reference.origin === "custom" &&
      entity.reference.typeId === "bakery_operation"
    ) {
      seeds.push(entity.reference);
    }
  }
  if (
    membership.nextCursor !== null ||
    membership.entities.length !== financierOperations.length + 1 ||
    membership.relationships.length !== financierOperations.length ||
    seeds.length !== financierOperations.length
  ) {
    return {
      kind: "invalid",
      message:
        "Load one complete financier procedure with exactly seven operation members.",
    };
  }
  // Operation-frontier traversal sees every workflow edge without expanding scenario backlinks.
  const graph = await readGraph(
    parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds,
      relationshipDefinition: null,
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    }),
  );
  if (graph.merchantRevision !== membership.merchantRevision) {
    return {
      kind: "invalid",
      message:
        "The workspace changed while reading this procedure. Reload and try again.",
    };
  }
  if (graph.entities.length >= 100 || graph.relationships.length >= 100) {
    return {
      kind: "invalid",
      message:
        "This procedure exceeds the supported graph size. Reduce its workflow connections before loading.",
    };
  }
  return { kind: "ready", graph };
}

export type ProcedureSnapshot = Readonly<{
  revision: CommerceSnapshotRevision;
  procedure: CustomCommerceEntity;
  operations: readonly CustomCommerceEntity[];
  equipment: readonly CustomCommerceEntity[];
  relationships: readonly CustomCommerceRelationship[];
}>;

export function compileBakeryGraph(
  result: CommerceGraphQueryResult,
  reference: CustomCommerceEntityRef,
  assumptions: Settings,
): ProcedureResult {
  if (result.nextCursor !== null) {
    return {
      kind: "invalid",
      message:
        "This procedure exceeds the supported graph size. Load a complete financier procedure with seven operations.",
    };
  }
  let procedure: CustomCommerceEntity | null = null;
  const operations: CustomCommerceEntity[] = [],
    equipment: CustomCommerceEntity[] = [],
    relationships: CustomCommerceRelationship[] = [];
  for (const entity of result.entities) {
    if (!isCustomCommerceEntity(entity)) {
      continue;
    }
    switch (entity.reference.typeId) {
      case "bakery_procedure":
        if (entity.reference.entityId === reference.entityId) {
          procedure = entity;
        }
        break;
      case "bakery_operation":
        operations.push(entity);
        break;
      case "bakery_equipment":
        equipment.push(entity);
        break;
    }
  }
  for (const relationship of result.relationships) {
    if (
      relationship.origin === "custom" &&
      relationship.definition.definitionId !== "bakery_scenario_procedure" &&
      relationship.definition.definitionId !== "bakery_production_procedure"
    ) {
      relationships.push(relationship);
    }
  }
  if (procedure === null) {
    return {
      kind: "invalid",
      message:
        "No readable bakery procedure was found with that entity ID. Your current simulation is unchanged.",
    };
  }
  return compileProcedure(
    {
      revision: result.merchantRevision,
      procedure,
      operations,
      equipment,
      relationships,
    },
    assumptions,
  );
}

export type ProcedureOperation = Readonly<{
  reference: CustomCommerceEntityRef;
  revision: CommerceEntityRevision;
  equipment: CustomCommerceEntityRef;
  assignment: CustomCommerceRelationshipRef;
  operation: Operation;
  station: StationId;
  minutes: number;
}>;

const compiled: unique symbol = Symbol("compiled bakery procedure");

export type CompiledProcedure = Readonly<{
  [compiled]: true;
  snapshotRevision: CommerceSnapshotRevision;
  revisionKey: string;
  reference: CustomCommerceEntityRef;
  operations: readonly ProcedureOperation[];
  settings: Settings;
}>;

export type ProcedureResult =
  | Readonly<{ kind: "ready"; procedure: CompiledProcedure; message?: never }>
  | Readonly<{ kind: "invalid"; message: string; procedure?: never }>;

export const scenarioAssumptionFields: ReadonlySet<SettingsField> = new Set([
  "workerCount",
  "horizonMinutes",
  "outageStart",
  "outageEnd",
]);

export type ProcedureAssumptionsResult =
  | Readonly<{
      kind: "valid";
      procedure: CompiledProcedure;
      field?: never;
      message?: never;
      settings?: never;
    }>
  | (Variant<SettingsResult, "invalid"> & {
      readonly procedure?: never;
    });

export function parseProcedureAssumptions(
  procedure: CompiledProcedure,
  raw: Readonly<Record<string, unknown>>,
): ProcedureAssumptionsResult {
  const inputs: Record<string, unknown> = { ...procedure.settings };
  for (const field of scenarioAssumptionFields) {
    inputs[field] = raw[field];
  }
  const result = parseSettings(inputs);
  if (result.kind === "invalid") {
    return result;
  }
  return {
    kind: "valid",
    procedure: Object.freeze({
      [compiled]: true as const,
      snapshotRevision: procedure.snapshotRevision,
      revisionKey: procedure.revisionKey,
      reference: procedure.reference,
      operations: procedure.operations,
      settings: result.settings,
    }),
  };
}

// Entity-plane parsing and authorization precede this cross-record domain boundary.
export function compileProcedure(
  snapshot: ProcedureSnapshot,
  assumptions: Settings,
): ProcedureResult {
  if (
    !activeType(snapshot.procedure, "bakery_procedure") ||
    snapshot.operations.length !== financierOperations.length ||
    snapshot.equipment.length !== 5
  ) {
    return invalid(
      "Load one active financier procedure, its seven operations and five equipment records.",
    );
  }
  const entities = [
    snapshot.procedure,
    ...snapshot.operations,
    ...snapshot.equipment,
  ];
  if (new Set(entities.map(entityKey)).size !== entities.length) {
    return invalid(
      "Each procedure object must have a unique entity reference.",
    );
  }
  const equipmentByStation = new Map<StationId, CustomCommerceEntity>();
  let ovenTrays = 0,
    rackTrays = 0;
  for (const item of snapshot.equipment) {
    if (!activeType(item, "bakery_equipment")) {
      return invalid(
        "Equipment must use the active bakery equipment schema, revision 1.",
      );
    }
    const id = stationValue(textAttribute(item, "station")),
      capacity = integerAttribute(item, "capacity_trays");
    if (
      id === null ||
      equipmentByStation.has(id) ||
      capacity === null ||
      capacity < 1 ||
      capacity > (id === "cool" ? 16 : 4)
    ) {
      return invalid(
        "Equipment needs a unique supported station and a valid tray capacity.",
      );
    }
    if (capacity < assumptions.traysPerBatch) {
      return invalid(
        "Each whole batch must fit on every assigned piece of equipment. Reduce the sample tray load before loading this procedure.",
      );
    }
    equipmentByStation.set(id, item);
    if (id === "bake") {
      ovenTrays = capacity;
    }
    if (id === "cool") {
      rackTrays = capacity;
    }
  }
  const operations = new Map<Operation, ProcedureOperation>();
  for (const item of snapshot.operations) {
    if (!activeType(item, "bakery_operation")) {
      return invalid(
        "Operations must use the active bakery operation schema, revision 1.",
      );
    }
    const operation = operationValue(textAttribute(item, "operation")),
      minutes = integerAttribute(item, "minutes");
    if (
      operation === null ||
      operations.has(operation) ||
      minutes === null ||
      minutes < 1 ||
      minutes > 60
    ) {
      return invalid(
        "Each financier operation needs a unique supported kind and a duration from 1 to 60 minutes.",
      );
    }
    const station =
        operation === "demould" || operation === "finishCooling"
          ? "cool"
          : operation,
      equipment = equipmentByStation.get(station),
      assignment =
        equipment === undefined
          ? undefined
          : findAssignmentRelationship(
              snapshot.relationships,
              item.reference,
              equipment.reference,
            );
    if (!equipment || !assignment) {
      return invalid(`Assign equipment for ${operation}.`);
    }
    operations.set(
      operation,
      Object.freeze({
        reference: frozenRef(item.reference),
        revision: item.revision,
        equipment: frozenRef(equipment.reference),
        assignment: frozenRelationshipRef(assignment),
        operation,
        station,
        minutes,
      }),
    );
  }
  const ordered: ProcedureOperation[] = [];
  for (const definition of financierOperations) {
    const operation = definition.operation;
    const item = operations.get(operation);
    if (!item) {
      return invalid(`Add the ${operation} operation.`);
    }
    ordered.push(item);
  }
  const remainingEdges = new Set<string>();
  let previous: ProcedureOperation | null = null;
  for (const item of ordered) {
    remainingEdges.add(
      edgeKey(
        "bakery_procedure_operation",
        snapshot.procedure.reference,
        item.reference,
      ),
    );
    remainingEdges.add(
      edgeKey("bakery_operation_equipment", item.reference, item.equipment),
    );
    if (previous !== null) {
      remainingEdges.add(
        edgeKey("bakery_operation_next", previous.reference, item.reference),
      );
    }
    previous = item;
  }
  const relationshipIds = new Set<string>();
  const invalidRelationshipMessage =
    "Use each supported procedure membership, equipment assignment and dependency exactly once. Extra connections and branches are unsupported.";
  for (const edge of snapshot.relationships) {
    if (edge.definition.revision !== 1) {
      return invalid(invalidRelationshipMessage);
    }
    if (relationshipIds.has(edge.relationshipId)) {
      return invalid(invalidRelationshipMessage);
    }
    const key = edgeKey(edge.definition.definitionId, edge.source, edge.target);
    if (!remainingEdges.has(key)) {
      return invalid(invalidRelationshipMessage);
    }
    remainingEdges.delete(key);
    relationshipIds.add(edge.relationshipId);
  }
  if (remainingEdges.size !== 0) {
    return invalid(
      "Connect every operation to its procedure and equipment, then connect stage → portion → bake → cool → demould → finishCooling → pack.",
    );
  }
  const raw: Record<string, unknown> = { ...assumptions, ovenTrays, rackTrays };
  for (const item of ordered) {
    raw[item.operation] = item.minutes;
  }
  const settings = parseSettings(raw);
  if (settings.kind === "invalid") {
    return invalid(settings.message);
  }
  return {
    kind: "ready",
    procedure: Object.freeze({
      [compiled]: true as const,
      snapshotRevision: snapshot.revision,
      revisionKey: bakeryProcedureKey(entities, snapshot.relationships),
      reference: frozenRef(snapshot.procedure.reference),
      operations: Object.freeze(ordered),
      settings: settings.settings,
    }),
  };
}

function invalid(message: string): ProcedureResult {
  return { kind: "invalid", message };
}

function activeType(entity: CustomCommerceEntity, type: string): boolean {
  return (
    entity.reference.typeId === type &&
    entity.typeRevision === 1 &&
    entity.state.state === "active"
  );
}

function frozenRef(
  reference: CustomCommerceEntityRef,
): CustomCommerceEntityRef {
  return Object.freeze({
    origin: "custom",
    typeId: reference.typeId,
    entityId: reference.entityId,
  });
}

function frozenRelationshipRef(
  relationship: CustomCommerceRelationship,
): CustomCommerceRelationshipRef {
  return Object.freeze({
    origin: "custom",
    relationshipId: relationship.relationshipId,
    definition: Object.freeze({
      origin: "custom",
      definitionId: relationship.definition.definitionId,
      revision: relationship.definition.revision,
    }),
    revision: relationship.revision,
  });
}

function findAssignmentRelationship(
  relationships: readonly CustomCommerceRelationship[],
  operation: CustomCommerceEntityRef,
  equipment: CustomCommerceEntityRef,
): CustomCommerceRelationship | undefined {
  let found: CustomCommerceRelationship | undefined;
  for (const relationship of relationships) {
    if (
      relationship.definition.definitionId === "bakery_operation_equipment" &&
      sameRef(relationship.source, operation) &&
      sameRef(relationship.target, equipment)
    ) {
      if (found !== undefined) return undefined;
      found = relationship;
    }
  }
  return found;
}

function sameRef(left: CommerceEntityRef, right: CommerceEntityRef): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function entityKey(entity: CustomCommerceEntity): string {
  return refKey(entity.reference);
}

function refKey(reference: CommerceEntityRef): string {
  return JSON.stringify([
    reference.origin,
    reference.typeId,
    reference.entityId,
  ]);
}

function edgeKey(
  definition: string,
  from: CommerceEntityRef,
  to: CommerceEntityRef,
): string {
  return JSON.stringify([definition, refKey(from), refKey(to)]);
}

function textAttribute(
  entity: CustomCommerceEntity,
  name: string,
): string | null {
  let result: string | null = null;
  for (const attribute of entity.attributes) {
    if (attribute.attributeId === name) {
      if (
        result !== null ||
        attribute.value.kind !== "short_text" ||
        !attributeScopeMatches(entity, attribute)
      ) {
        return null;
      }
      result = attribute.value.value;
    }
  }
  return result;
}

function integerAttribute(
  entity: CustomCommerceEntity,
  name: string,
): number | null {
  let result: number | null = null;
  for (const attribute of entity.attributes) {
    if (attribute.attributeId === name) {
      if (
        result !== null ||
        attribute.value.kind !== "integer" ||
        !attributeScopeMatches(entity, attribute)
      ) {
        return null;
      }
      const value = Number(attribute.value.value);
      if (!Number.isSafeInteger(value)) {
        return null;
      }
      result = value;
    }
  }
  return result;
}

function attributeScopeMatches(
  entity: CustomCommerceEntity,
  attribute: CustomCommerceEntity["attributes"][number],
): boolean {
  return (
    attribute.definitionRevision === 1 &&
    attribute.scope.kind === "custom" &&
    attribute.scope.entityTypeId === entity.reference.typeId &&
    attribute.scope.typeRevision === entity.typeRevision
  );
}

function stationValue(value: string | null): StationId | null {
  switch (value) {
    case "stage":
    case "portion":
    case "bake":
    case "cool":
    case "pack":
      return value;
    default:
      return null;
  }
}

function operationValue(value: string | null): Operation | null {
  return value === "demould" || value === "finishCooling"
    ? value
    : stationValue(value);
}
