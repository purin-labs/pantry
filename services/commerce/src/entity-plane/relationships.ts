import type {
  CommerceEntity,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceEntityPlaneError,
  CommerceRelationship,
  RelationshipDefinition,
  RelationshipDefinitionId,
  RelationshipDefinitionRevision,
  RelationshipDefinitionRef,
  RelationshipId,
  RelationshipRevision,
  SystemCommerceEntityRef,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  parseEntityRef,
  parsePositiveRevision,
  parseRelationshipDefinition,
  parseRelationshipDefinitionId,
  parseRelationshipId,
  parseSystemEntityRef,
} from "./parsers.ts";
import {
  readCustomEntity,
  readMerchant,
  readSystemEntity,
} from "./entities.ts";
import { validateCommerceRelationshipWithLexicon } from "./lexicon.ts";
import { relationshipDefinitionReference } from "@seams/commerce-contracts/commerce-relationship-references";
import {
  FOOD_SERVICE_ENTITY_ROWS,
  readShipmentProductionBatches,
} from "../plugins/food-service/index.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever, parseJson } from "@seams/std";
type SystemRelationship = VariantBy<CommerceRelationship, "origin", "system">;
type CustomRelationship = VariantBy<CommerceRelationship, "origin", "custom">;
type SystemKind = SystemCommerceEntityRef["typeId"];
type SystemDefinition = VariantBy<RelationshipDefinition, "origin", "system">;
type CustomDefinition = VariantBy<RelationshipDefinition, "origin", "custom">;
type SystemDefinitionId = SystemDefinition["definitionId"];

type RelationshipRow = Readonly<{
  relationshipId: string;
  relationshipDefinitionId: string;
  relationshipDefinitionRevision: number;
  revision: number;
  lifecycleState: "active" | "deleted";
  sourceOrigin: "system" | "custom";
  sourceTypeId: string;
  sourceEntityId: string;
  targetOrigin: "system" | "custom";
  targetTypeId: string;
  targetEntityId: string;
}>;
type DefinitionRow = Readonly<{
  relationshipDefinitionId: string;
  revision: number;
  lifecycleState: "draft" | "published" | "archived";
  definitionJson: string;
}>;
type CanonicalEdge = Readonly<{
  definitionId: SystemDefinitionId;
  source: SystemCommerceEntityRef;
  target: SystemCommerceEntityRef;
}>;

const SYSTEM_DEFINITIONS: readonly SystemDefinition[] = [
  systemDefinition(
    "order_shipment",
    "Order shipment",
    "Shipment",
    "one_to_many",
    "detach",
    "internal",
  ),
  systemDefinition(
    "order_fulfillment",
    "Order fulfillment",
    "Fulfillment",
    "one_to_many",
    "detach",
    "internal",
  ),
  systemDefinition(
    "fulfillment_shipment",
    "Fulfillment shipment",
    "Shipment",
    "one_to_one",
    "detach",
    "internal",
  ),
  systemDefinition(
    "recipe_revision_production_batch",
    "Production batches",
    "Recipe revision",
    "one_to_many",
    "detach",
    "internal",
  ),
  systemDefinition(
    "production_batch_recipe_revision",
    "Recipe revision",
    "Production batches",
    "many_to_one",
    "detach",
    "internal",
  ),
  systemDefinition(
    "shipment_production_batch",
    "Production batches",
    "Shipment",
    "one_to_many",
    "detach",
    "internal",
  ),
];

export function readSystemRelationshipDefinition(
  definitionId: SystemDefinitionId,
): SystemDefinition | undefined {
  return SYSTEM_DEFINITIONS.find(
    (definition) => definition.definitionId === definitionId,
  );
}

export function listRelationshipDefinitions(
  database: CommerceDatabase,
  merchantId: string,
): readonly RelationshipDefinition[] {
  const rows = database
    .prepare(
      `SELECT definition.relationship_definition_id AS relationshipDefinitionId,
            definition.revision, head.lifecycle_state AS lifecycleState,
            definition.definition_json AS definitionJson
     FROM relationship_definition AS definition
     JOIN relationship_definition_head AS head
       ON head.merchant_id = definition.merchant_id
      AND head.relationship_definition_id = definition.relationship_definition_id
      AND head.published_revision = definition.revision
     WHERE definition.merchant_id = ? AND head.lifecycle_state = 'published'
     ORDER BY definition.relationship_definition_id`,
    )
    .all<DefinitionRow>(merchantId);
  return [...SYSTEM_DEFINITIONS, ...rows.map(parseCustomDefinitionRow)];
}

export function readCustomRelationshipDefinition(
  database: CommerceDatabase,
  merchantId: string,
  definitionId: RelationshipDefinitionId,
): CustomDefinition | undefined {
  const row = database
    .prepare(
      `SELECT definition.relationship_definition_id AS relationshipDefinitionId,
            definition.revision, head.lifecycle_state AS lifecycleState,
            definition.definition_json AS definitionJson
     FROM relationship_definition AS definition
     JOIN relationship_definition_head AS head
       ON head.merchant_id = definition.merchant_id
      AND head.relationship_definition_id = definition.relationship_definition_id
      AND head.current_revision = definition.revision
     WHERE definition.merchant_id = ? AND definition.relationship_definition_id = ?`,
    )
    .get<DefinitionRow>(merchantId, definitionId);
  if (row === undefined) return undefined;
  const definition = parseCustomDefinitionRow(row);
  return definition.origin === "custom" ? definition : undefined;
}

export function readCustomRelationshipDefinitionRevision(
  database: CommerceDatabase,
  merchantId: string,
  definitionId: RelationshipDefinitionId,
  revision: number,
): CustomDefinition | undefined {
  const row = database
    .prepare(
      `SELECT relationship_definition_id AS relationshipDefinitionId,
            revision, lifecycle_state AS lifecycleState, definition_json AS definitionJson
     FROM relationship_definition
     WHERE merchant_id = ? AND relationship_definition_id = ? AND revision = ?`,
    )
    .get<DefinitionRow>(merchantId, definitionId, revision);
  if (row === undefined) return undefined;
  const definition = parseCustomDefinitionRow(row);
  return definition.origin === "custom" ? definition : undefined;
}

export function createRelationshipDefinition(
  database: CommerceDatabase,
  merchantId: string,
  definition: CustomDefinition,
  now: string,
): void {
  const current = database
    .prepare(
      `SELECT current_revision AS revision, lifecycle_state AS lifecycleState
     FROM relationship_definition_head
     WHERE merchant_id = ? AND relationship_definition_id = ?`,
    )
    .get<
      Readonly<{
        revision: number;
        lifecycleState: "draft" | "published" | "archived";
      }>
    >(merchantId, definition.definitionId);
  if (current !== undefined) {
    if (current.lifecycleState === "draft")
      throw new Error("Relationship definition already has a draft revision");
    if (Number(definition.revision) !== Number(current.revision) + 1)
      throw new Error(
        "Relationship definition revision must advance exactly once",
      );
  } else if (Number(definition.revision) !== 1) {
    throw new Error("Relationship definition must start at revision 1");
  }
  const inserted = database
    .prepare(
      `INSERT INTO relationship_definition (
       merchant_id, relationship_definition_id, revision, lifecycle_state,
       origin, source_type_id, target_type_id, cardinality, definition_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'draft', 'custom', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      definition.definitionId,
      definition.revision,
      entityTypeStorageId(definition.sourceType),
      entityTypeStorageId(definition.targetType),
      definition.cardinality,
      JSON.stringify(definition),
      now,
      now,
    );
  if (inserted.changes !== 1)
    throw new Error("Relationship definition revision was not written");
  const published = database
    .prepare(
      `INSERT INTO relationship_definition_head (
       merchant_id, relationship_definition_id, current_revision, published_revision, lifecycle_state, updated_at
     ) VALUES (?, ?, ?, NULL, 'draft', ?)
     ON CONFLICT (merchant_id, relationship_definition_id) DO UPDATE SET
       current_revision = excluded.current_revision,
       lifecycle_state = 'draft',
       updated_at = excluded.updated_at`,
    )
    .run(merchantId, definition.definitionId, definition.revision, now);
  if (published.changes !== 1)
    throw new Error("Relationship definition draft was not written");
}

export function publishRelationshipDefinition(
  database: CommerceDatabase,
  merchantId: string,
  definitionId: RelationshipDefinitionId,
  expectedRevision: number,
  now: string,
): void {
  const head = database
    .prepare(
      `UPDATE relationship_definition_head
     SET published_revision = current_revision, lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND relationship_definition_id = ? AND current_revision = ?
       AND EXISTS (
         SELECT 1 FROM relationship_definition
         WHERE merchant_id = ? AND relationship_definition_id = ? AND revision = ? AND lifecycle_state = 'draft'
       )`,
    )
    .run(
      now,
      merchantId,
      definitionId,
      expectedRevision,
      merchantId,
      definitionId,
      expectedRevision,
    );
  if (head.changes !== 1)
    throw new Error("Relationship definition publication revision conflict");
  const row = database
    .prepare(
      `UPDATE relationship_definition SET lifecycle_state = 'published', updated_at = ?
     WHERE merchant_id = ? AND relationship_definition_id = ? AND revision = ? AND lifecycle_state = 'draft'`,
    )
    .run(now, merchantId, definitionId, expectedRevision);
  if (row.changes !== 1)
    throw new Error("Relationship definition publication revision conflict");
}

export function writeRelationship(
  database: CommerceDatabase,
  merchantId: string,
  relationshipId: RelationshipId,
  definition: CustomDefinition,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO commerce_relationship (
       merchant_id, relationship_id, relationship_definition_id,
       relationship_definition_revision, revision, lifecycle_state,
       source_origin, source_type_id, source_entity_id,
       target_origin, target_type_id, target_entity_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      relationshipId,
      definition.definitionId,
      definition.revision,
      source.origin,
      entityTypeStorageIdFromRef(source),
      entityIdFromRef(source),
      target.origin,
      entityTypeStorageIdFromRef(target),
      entityIdFromRef(target),
      now,
      now,
    );
}

export function relationshipCardinalityConflict(
  database: CommerceDatabase,
  merchantId: string,
  definition: CustomDefinition,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
): CommerceEntityPlaneError | undefined {
  return relationshipCardinalityConflictForScope(
    database,
    merchantId,
    definition,
    source,
    target,
    { kind: "all" },
  );
}

export function relationshipReplacementCardinalityConflict(
  database: CommerceDatabase,
  merchantId: string,
  definition: CustomDefinition,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
  relationshipId: RelationshipId,
): CommerceEntityPlaneError | undefined {
  return relationshipCardinalityConflictForScope(
    database,
    merchantId,
    definition,
    source,
    target,
    { kind: "excluding", relationshipId },
  );
}

type CardinalityScope =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "excluding"; relationshipId: RelationshipId }>;

function relationshipCardinalityConflictForScope(
  database: CommerceDatabase,
  merchantId: string,
  definition: CustomDefinition,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
  scope: CardinalityScope,
): CommerceEntityPlaneError | undefined {
  const sourceId = entityIdFromRef(source);
  const sourceTypeId = entityTypeStorageIdFromRef(source);
  const targetId = entityIdFromRef(target);
  const targetTypeId = entityTypeStorageIdFromRef(target);
  const sourceOrigin = source.origin;
  const targetOrigin = target.origin;
  let predicate: string;
  const values: (string | number)[] = [
    merchantId,
    definition.definitionId,
    definition.revision,
  ];
  const exclusion =
    scope.kind === "all" ? "" : "AND relationship_id <> ?";
  if (scope.kind === "excluding") values.push(scope.relationshipId);
  switch (definition.cardinality) {
    case "one_to_one":
      predicate = `(source_origin = ? AND source_type_id = ? AND source_entity_id = ?) OR (target_origin = ? AND target_type_id = ? AND target_entity_id = ?)`;
      values.push(
        sourceOrigin,
        sourceTypeId,
        sourceId,
        targetOrigin,
        targetTypeId,
        targetId,
      );
      break;
    case "one_to_many":
      predicate = `target_origin = ? AND target_type_id = ? AND target_entity_id = ?`;
      values.push(targetOrigin, targetTypeId, targetId);
      break;
    case "many_to_one":
      predicate = `source_origin = ? AND source_type_id = ? AND source_entity_id = ?`;
      values.push(sourceOrigin, sourceTypeId, sourceId);
      break;
    case "many_to_many":
      return undefined;
    default:
      return assertNever(
        definition.cardinality,
        "Unsupported relationship cardinality",
      );
  }
  const existing = database
    .prepare(
      `SELECT 1 AS present FROM commerce_relationship
     WHERE merchant_id = ? AND relationship_definition_id = ?
       AND relationship_definition_revision = ? AND lifecycle_state = 'active'
       ${exclusion}
       AND (${predicate}) LIMIT 1`,
    )
    .get<{ present: number }>(...values);
  return existing === undefined ? undefined : { code: "duplicate_identity" };
}

export function replaceRelationshipTarget(
  database: CommerceDatabase,
  merchantId: string,
  relationshipId: RelationshipId,
  expectedRevision: RelationshipRevision,
  replacementTarget: CommerceEntityRef,
  now: string,
): RelationshipRevision {
  const nextRevision = parsePositiveRevision<RelationshipRevision>(
    Number(expectedRevision) + 1,
    "relationship.revision",
  );
  const result = database
    .prepare(
      `UPDATE commerce_relationship
     SET revision = ?, target_origin = ?, target_type_id = ?,
         target_entity_id = ?, updated_at = ?
     WHERE merchant_id = ? AND relationship_id = ? AND revision = ? AND lifecycle_state = 'active'`,
    )
    .run(
      nextRevision,
      replacementTarget.origin,
      entityTypeStorageIdFromRef(replacementTarget),
      entityIdFromRef(replacementTarget),
      now,
      merchantId,
      relationshipId,
      expectedRevision,
    );
  if (result.changes !== 1)
    throw new Error(
      "Relationship changed while committing entity-plane command",
    );
  return nextRevision;
}

export function deleteRelationship(
  database: CommerceDatabase,
  merchantId: string,
  relationshipId: RelationshipId,
  expectedRevision: RelationshipRevision,
  now: string,
): number {
  const nextRevision = Number(expectedRevision) + 1;
  const result = database
    .prepare(
      `UPDATE commerce_relationship
     SET revision = ?, lifecycle_state = 'deleted', updated_at = ?
     WHERE merchant_id = ? AND relationship_id = ? AND revision = ? AND lifecycle_state = 'active'`,
    )
    .run(nextRevision, now, merchantId, relationshipId, expectedRevision);
  if (result.changes !== 1)
    throw new Error(
      "Relationship changed while committing entity-plane command",
    );
  return nextRevision;
}

export function readRelationship(
  database: CommerceDatabase,
  merchantId: string,
  relationshipId: RelationshipId,
  merchantRevision: number,
): CommerceRelationship | undefined {
  const row = database
    .prepare(
      `SELECT relationship_id AS relationshipId,
            relationship_definition_id AS relationshipDefinitionId,
            relationship_definition_revision AS relationshipDefinitionRevision,
            revision, lifecycle_state AS lifecycleState,
            source_origin AS sourceOrigin, source_type_id AS sourceTypeId,
            source_entity_id AS sourceEntityId,
            target_origin AS targetOrigin, target_type_id AS targetTypeId,
            target_entity_id AS targetEntityId
     FROM commerce_relationship
     WHERE merchant_id = ? AND relationship_id = ?`,
    )
    .get<RelationshipRow>(merchantId, relationshipId);
  if (row === undefined || row.lifecycleState !== "active") return undefined;
  const definition = readCustomRelationshipDefinitionRevision(
    database,
    merchantId,
    parseRelationshipDefinitionId(row.relationshipDefinitionId),
    row.relationshipDefinitionRevision,
  );
  return definition === undefined
    ? undefined
    : relationshipFromRow(row, definition);
}

export function listRelationships(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
  seed: CommerceEntityRef | undefined,
  definition: RelationshipDefinitionRef | null | undefined,
): readonly CommerceRelationship[] {
  const canonical = listCanonicalRelationships(
    database,
    merchantId,
    seed,
    definition,
  );
  const custom = listCustomRelationships(
    database,
    merchantId,
    seed,
    definition,
  );
  return [...canonical, ...custom];
}

export function findEntity(
  database: CommerceDatabase,
  merchantId: string,
  reference: CommerceEntityRef,
  merchantRevision: number,
): CommerceEntity | undefined {
  return reference.origin === "system"
    ? readSystemEntity(database, merchantId, reference, merchantRevision)
    : readCustomEntity(database, merchantId, reference, merchantRevision);
}

function listCanonicalRelationships(
  database: CommerceDatabase,
  merchantId: string,
  seed: CommerceEntityRef | undefined,
  requestedDefinition: RelationshipDefinitionRef | null | undefined,
): readonly CommerceRelationship[] {
  const merchant = readMerchant(database, merchantId);
  if (merchant === undefined)
    throw new Error(`Merchant not found: ${merchantId}`);
  const edges = canonicalEdges(database, merchantId);
  return edges
    .filter(
      (edge) =>
        requestedDefinition === null ||
        requestedDefinition === undefined ||
        (requestedDefinition.origin === "system" &&
          String(edge.definitionId) ===
            String(requestedDefinition.definitionId)),
    )
    .filter(
      (edge) =>
        seed === undefined ||
        sameRef(edge.source, seed) ||
        sameRef(edge.target, seed),
    )
    .map((edge) => canonicalRelationship(database, merchantId, edge));
}

function listCustomRelationships(
  database: CommerceDatabase,
  merchantId: string,
  seed: CommerceEntityRef | undefined,
  requestedDefinition: RelationshipDefinitionRef | null | undefined,
): readonly CommerceRelationship[] {
  if (requestedDefinition?.origin === "system") return [];
  const requestedDefinitionId = requestedDefinition?.definitionId ?? null;
  const requestedDefinitionRevision =
    requestedDefinition?.origin === "custom"
      ? Number(requestedDefinition.revision)
      : null;
  const rows = database
    .prepare(
      `SELECT relationship_id AS relationshipId,
            relationship_definition_id AS relationshipDefinitionId,
            relationship_definition_revision AS relationshipDefinitionRevision,
            revision, lifecycle_state AS lifecycleState,
            source_origin AS sourceOrigin, source_type_id AS sourceTypeId,
            source_entity_id AS sourceEntityId,
            target_origin AS targetOrigin, target_type_id AS targetTypeId,
            target_entity_id AS targetEntityId
     FROM commerce_relationship
     WHERE merchant_id = ? AND lifecycle_state = 'active'
       AND (? IS NULL OR relationship_definition_id = ?)
       AND (? IS NULL OR relationship_definition_revision = ?)
       ORDER BY relationship_id`,
    )
    .all<RelationshipRow>(
      merchantId,
      requestedDefinitionId,
      requestedDefinitionId,
      requestedDefinitionRevision,
      requestedDefinitionRevision,
    );
  return rows
    .map((row) => {
      const definition = readCustomRelationshipDefinitionRevision(
        database,
        merchantId,
        parseRelationshipDefinitionId(row.relationshipDefinitionId),
        row.relationshipDefinitionRevision,
      );
      return definition === undefined
        ? undefined
        : relationshipFromRow(row, definition);
    })
    .filter(isRelationship)
    .filter(
      (relationship) =>
        seed === undefined ||
        sameRef(relationship.source, seed) ||
        sameRef(relationship.target, seed),
    );
}

function canonicalEdges(
  database: CommerceDatabase,
  merchantId: string,
): readonly CanonicalEdge[] {
  const edges: CanonicalEdge[] = [];
  appendForeignKeyEdges(
    database,
    merchantId,
    edges,
    "order_shipment",
    "shipment",
    "order_id",
    "order",
    "resource_id",
  );
  appendForeignKeyEdges(
    database,
    merchantId,
    edges,
    "order_fulfillment",
    "fulfillment",
    "order_id",
    "order",
    "resource_id",
  );
  appendForeignKeyEdges(
    database,
    merchantId,
    edges,
    "fulfillment_shipment",
    "shipment",
    "fulfillment_id",
    "fulfillment",
    "resource_id",
  );
  appendShipmentProductionBatchEdges(database, merchantId, edges);
  return edges;
}

function appendForeignKeyEdges(
  database: CommerceDatabase,
  merchantId: string,
  edges: CanonicalEdge[],
  definitionId: SystemDefinitionId,
  targetTable: string,
  targetForeignKey: string,
  sourceType: SystemKind,
  sourceKey: string,
): void {
  const definition = SYSTEM_DEFINITIONS.find(
    (entry) => entry.definitionId === definitionId,
  );
  if (definition === undefined)
    throw new Error(
      `System relationship definition is unavailable: ${definitionId}`,
    );
  const targetType = endpointTypes(definition.definitionId).target;
  const rows = database
    .prepare(
      `SELECT target.resource_id AS targetId, source.${sourceKey} AS sourceId
     FROM ${targetTable} AS target
     JOIN ${sourceTable(sourceType)} AS source
       ON source.merchant_id = target.merchant_id AND source.${sourceKey} = target.${targetForeignKey}
     WHERE target.merchant_id = ?`,
    )
    .all<Readonly<{ sourceId: string; targetId: string }>>(merchantId);
  for (const row of rows) {
    edges.push({
      definitionId,
      source: parseSystemEntityRef(sourceType, row.sourceId),
      target: parseSystemEntityRef(targetType, row.targetId),
    });
  }
}

function appendShipmentProductionBatchEdges(
  database: CommerceDatabase,
  merchantId: string,
  edges: CanonicalEdge[],
): void {
  const definitionId: SystemDefinitionId = "shipment_production_batch";
  const rows = readShipmentProductionBatches(database, merchantId);
  for (const row of rows) {
    edges.push({
      definitionId,
      source: parseSystemEntityRef("shipment", row.sourceId),
      target: parseSystemEntityRef("production_batch", row.targetId),
    });
  }
}

function canonicalRelationship(
  database: CommerceDatabase,
  merchantId: string,
  edge: CanonicalEdge,
): SystemRelationship {
  const relationshipId = parseRelationshipId(
    `system:${edge.definitionId}:${entityIdFromRef(edge.source)}:${entityIdFromRef(edge.target)}`,
  );
  const sourceEntity = readSystemEntity(
    database,
    merchantId,
    edge.source,
    Number(readMerchant(database, merchantId)?.revision ?? 0),
  );
  const targetEntity = readSystemEntity(
    database,
    merchantId,
    edge.target,
    Number(readMerchant(database, merchantId)?.revision ?? 0),
  );
  if (
    sourceEntity === undefined ||
    sourceEntity.reference.origin !== "system" ||
    !("provenance" in sourceEntity) ||
    sourceEntity.provenance === undefined
  )
    throw new Error("Canonical relationship source entity is unavailable");
  if (targetEntity === undefined || targetEntity.reference.origin !== "system")
    throw new Error("Canonical relationship target entity is unavailable");
  const definition = readSystemRelationshipDefinition(edge.definitionId);
  if (definition === undefined)
    throw new Error(
      `System relationship definition is unavailable: ${edge.definitionId}`,
    );
  const relationship: SystemRelationship = {
    origin: "system",
    relationshipId,
    definition: relationshipDefinitionReference(definition),
    sensitivity: definition.sensitivity,
    source: edge.source,
    target: edge.target,
    revision: parsePositiveRevision<RelationshipRevision>(
      targetEntity.revision,
      "systemRelationship.revision",
    ),
    provenance: sourceEntity.provenance,
  };
  validateCommerceRelationshipWithLexicon(relationship, definition);
  return relationship;
}

function relationshipFromRow(
  row: RelationshipRow,
  definition: CustomDefinition,
): CustomRelationship {
  const source = parseEntityRef({
    origin: row.sourceOrigin,
    typeId: row.sourceTypeId,
    entityId: row.sourceEntityId,
  });
  const target = parseEntityRef({
    origin: row.targetOrigin,
    typeId: row.targetTypeId,
    entityId: row.targetEntityId,
  });
  if (source.origin === "system" && target.origin === "system")
    throw new Error("Stored custom relationship has only system endpoints");
  if (
    !sameEntityType(source, definition.sourceType) ||
    !sameEntityType(target, definition.targetType)
  )
    throw new Error("Stored custom relationship endpoint type mismatch");
  return {
    origin: "custom",
    relationshipId: parseRelationshipId(row.relationshipId),
    definition: relationshipDefinitionReference(definition),
    sensitivity: definition.sensitivity,
    source,
    target,
    revision: parsePositiveRevision<RelationshipRevision>(
      row.revision,
      "relationship.revision",
    ),
  };
}

function parseCustomDefinitionRow(row: DefinitionRow): RelationshipDefinition {
  const definition = parseRelationshipDefinition(parseJson(row.definitionJson));
  if (definition.origin !== "custom")
    throw new Error("Stored relationship definition is not custom");
  if (
    String(definition.definitionId) !== row.relationshipDefinitionId ||
    Number(definition.revision) !== row.revision
  )
    throw new Error("Stored relationship definition identity mismatch");
  return definition;
}

function systemDefinition(
  definitionId: SystemDefinitionId,
  sourceLabel: string,
  inverseLabel: string,
  cardinality: SystemDefinition["cardinality"],
  deletionBehavior: SystemDefinition["deletionBehavior"],
  sensitivity: SystemDefinition["sensitivity"],
): SystemDefinition {
  return {
    origin: "system",
    definitionId,
    sourceLabel,
    inverseLabel,
    cardinality,
    deletionBehavior,
    sensitivity,
    revision: parsePositiveRevision<RelationshipDefinitionRevision>(
      1,
      "systemRelationshipDefinition.revision",
    ),
  };
}

function endpointTypes(
  definitionId: SystemDefinitionId,
): Readonly<{ source: SystemKind; target: SystemKind }> {
  switch (definitionId) {
    case "order_shipment":
      return { source: "order", target: "shipment" };
    case "order_fulfillment":
      return { source: "order", target: "fulfillment" };
    case "fulfillment_shipment":
      return { source: "fulfillment", target: "shipment" };
    case "recipe_revision_production_batch":
      return { source: "recipe_revision", target: "production_batch" };
    case "production_batch_recipe_revision":
      return { source: "production_batch", target: "recipe_revision" };
    case "shipment_production_batch":
      return { source: "shipment", target: "production_batch" };
    default:
      throw new Error(
        `Unsupported system relationship definition: ${definitionId}`,
      );
  }
}

function sourceTable(sourceType: SystemKind): string {
  switch (sourceType) {
    case "order":
      return "commerce_order";
    case "fulfillment":
      return "fulfillment";
    case "recipe_revision":
    case "production_batch":
      return FOOD_SERVICE_ENTITY_ROWS.table;
    default:
      throw new Error(
        `Unsupported canonical relationship source: ${sourceType}`,
      );
  }
}

function entityTypeStorageId(typeId: CommerceEntityTypeId): string {
  return typeId.typeId;
}

function entityTypeStorageIdFromRef(reference: CommerceEntityRef): string {
  return reference.typeId;
}

function entityIdFromRef(reference: CommerceEntityRef): string {
  return reference.entityId;
}

function sameRef(left: CommerceEntityRef, right: CommerceEntityRef): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function sameEntityType(
  reference: CommerceEntityRef,
  typeId: CommerceEntityTypeId,
): boolean {
  return (
    reference.origin === typeId.origin && reference.typeId === typeId.typeId
  );
}

function isRelationship(
  value: CustomRelationship | undefined,
): value is CustomRelationship {
  return value !== undefined;
}
