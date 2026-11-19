import type {
  CommerceEntityRef,
  SystemCommerceEntityRef,
  CommerceRelationship,
  CommerceRelationshipRef,
  CommerceQueryPlanErrorCapability,
  RelationshipDefinition,
  RelationshipRevision,
  SourceProvenance,
  SystemRelationshipDefinitionKind,
} from "@purin-labs/commerce-contracts";
import {
  compileCommerceRelationshipTraversalStepSql,
  type CommerceSqliteBinding,
  type CommerceSqliteRelationshipTraversalPlan,
} from "@purin-labs/commerce-query-sqlite";
import type { CommerceDatabase, CommerceSqlValue } from "../database.ts";
import {
  parseEntityRef,
  parsePositiveRevision,
  parseRelationshipDefinitionId,
  parseRelationshipId,
  parseSensitivity,
} from "./parsers.ts";
import {
  readCustomRelationshipDefinitionRevision,
  readSystemRelationshipDefinition,
} from "./relationships.ts";
import { readMerchant, readSystemEntity } from "./entities.ts";
import { validateCommerceRelationshipWithLexicon } from "./lexicon.ts";
import { refreshCommerceAttributeRelation } from "./commerce-attribute-relation.ts";
import {
  relationshipDefinitionReference,
  sameRelationshipDefinitionRef,
} from "@purin-labs/commerce-contracts/commerce-relationship-references";
import {
  assertExactRelationColumns,
  explainUsesIndex,
  normalizeRelationSql as normalizeSql,
  relationTableHasIndex,
  syncDerivedRelationRows,
} from "./relation-schema.ts";
import { latestFoodServiceResources } from "../plugins/food-service/index.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import { isNormalizedText } from "@purin-labs/std";

const RELATION_SCHEMA_VERSION = 7;

type RelationshipRelationViewRow = Readonly<{
  merchant_id: unknown;
  relationship_origin: unknown;
  relationship_id: unknown;
  relationship_revision: unknown;
  definition_origin: unknown;
  definition_id: unknown;
  definition_revision: unknown;
  sensitivity: unknown;
  source_origin: unknown;
  source_type_id: unknown;
  source_entity_id: unknown;
  target_origin: unknown;
  target_type_id: unknown;
  target_entity_id: unknown;
  payload_json: unknown;
  provenance_json: unknown;
}>;

type RelationSchemaRow = Readonly<{ version: number; viewSql: string | null }>;

type CommerceRelationshipRelationRow = Readonly<{
  merchantId: string;
  relationshipOrigin: "system" | "custom";
  relationshipId: string;
  relationshipRevision: number;
  definitionOrigin: "system" | "custom";
  definitionId: string;
  definitionRevision: number;
  sensitivity: ReturnType<typeof parseSensitivity>;
  source: CommerceEntityRef;
  target: CommerceEntityRef;
  payloadJson: string;
  provenanceJson: string;
}>;

type CommerceRelationshipTraversalStepResult =
  | Readonly<{ kind: "rows"; rows: readonly CommerceRelationshipRelationRow[] }>
  | Readonly<{
      kind: "unsupported";
      capability: CommerceQueryPlanErrorCapability;
    }>;

const RELATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_relationship_relation_schema (
  relation_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  view_sql TEXT NOT NULL
) STRICT;
`;

const RELATION_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_relationship_relation (
  merchant_id TEXT NOT NULL,
  relationship_origin TEXT NOT NULL CHECK (relationship_origin IN ('system', 'custom')),
  relationship_id TEXT NOT NULL,
  relationship_revision INTEGER NOT NULL CHECK (relationship_revision > 0),
  definition_origin TEXT NOT NULL CHECK (definition_origin IN ('system', 'custom')),
  definition_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  source_origin TEXT NOT NULL CHECK (source_origin IN ('system', 'custom')),
  source_type_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_origin TEXT NOT NULL CHECK (target_origin IN ('system', 'custom')),
  target_type_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (merchant_id, relationship_origin, relationship_id)
) STRICT;

CREATE INDEX IF NOT EXISTS commerce_relationship_relation_source
  ON commerce_relationship_relation (
    merchant_id, definition_origin, definition_id, definition_revision,
    source_origin, source_type_id, source_entity_id
  );
CREATE INDEX IF NOT EXISTS commerce_relationship_relation_target
  ON commerce_relationship_relation (
    merchant_id, definition_origin, definition_id, definition_revision,
    target_origin, target_type_id, target_entity_id
  );
`;

const RELATIONSHIP_RELATION_COLUMNS = [
  "merchant_id",
  "relationship_origin",
  "relationship_id",
  "relationship_revision",
  "definition_origin",
  "definition_id",
  "definition_revision",
  "sensitivity",
  "source_origin",
  "source_type_id",
  "source_entity_id",
  "target_origin",
  "target_type_id",
  "target_entity_id",
  "payload_json",
  "provenance_json",
] as const;

export function initializeCommerceRelationshipRelation(
  database: CommerceDatabase,
): void {
  database.transaction(() => {
    database.exec(`${RELATION_SCHEMA}\n${RELATION_TABLE_SCHEMA}`);
    const expectedViewSql = normalizeSql(
      createCommerceRelationshipRelationSourceViewSql(),
    );
    const installed = database
      .prepare(
        `SELECT version, view_sql AS viewSql
       FROM commerce_relationship_relation_schema
       WHERE relation_name = 'commerce_relationship_relation'`,
      )
      .get<RelationSchemaRow>();
    // Versions 2 and 7 share the materialized relation; normalize its persisted marker.
    if (
      installed !== undefined &&
      installed.version !== 2 &&
      installed.version !== RELATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported commerce_relationship_relation schema version: ${installed.version}`,
      );
    }
    const existingView = database
      .prepare(
        `SELECT sql FROM sqlite_master
       WHERE type = 'view' AND name = 'commerce_relationship_relation_source_view'`,
      )
      .get<Readonly<{ sql: string | null }>>();
    const viewNeedsInstall =
      existingView === undefined ||
      existingView.sql === null ||
      installed?.viewSql !== expectedViewSql ||
      normalizeSql(existingView.sql) !== expectedViewSql;
    if (viewNeedsInstall) {
      database.exec(
        "DROP VIEW IF EXISTS commerce_relationship_relation_source_view",
      );
      database.exec(createCommerceRelationshipRelationSourceViewSql());
    }
    if (installed === undefined) {
      database
        .prepare(
          `INSERT INTO commerce_relationship_relation_schema (relation_name, version, view_sql)
         VALUES ('commerce_relationship_relation', ?, ?)`,
        )
        .run(RELATION_SCHEMA_VERSION, expectedViewSql);
    } else if (
      viewNeedsInstall ||
      installed.version !== RELATION_SCHEMA_VERSION
    ) {
      database
        .prepare(
          `UPDATE commerce_relationship_relation_schema SET version = ?, view_sql = ?
         WHERE relation_name = 'commerce_relationship_relation'`,
        )
        .run(RELATION_SCHEMA_VERSION, expectedViewSql);
    }
    assertCommerceRelationshipRelation(database, expectedViewSql);
    assertCanonicalRelationshipProvenance(database);
    refreshCommerceRelationshipRelation(database);
  });
}

export function readRelationshipTraversalStep(
  database: CommerceDatabase,
  ownerId: string,
  plan: CommerceSqliteRelationshipTraversalPlan,
  frontier: readonly CommerceEntityRef[],
  remaining: number,
): CommerceRelationshipTraversalStepResult {
  refreshCommerceRelationshipRelation(database, ownerId);
  const compiled = compileCommerceRelationshipTraversalStepSql({
    ownerId,
    plan,
    frontier,
    remaining,
  });
  if (compiled.kind === "unsupported") return compiled;
  if (compiled.statement.execution.kind !== "relationship_traversal_step") {
    throw new Error(
      "Relationship traversal compiler returned the wrong execution kind",
    );
  }
  const bindings = compiled.statement.bindings.map(toCommerceSqlValue);
  const rows = database
    .prepare(compiled.statement.sql)
    .all<RelationshipRelationViewRow>(...bindings)
    .map(parseCommerceRelationshipRelationRow);
  return { kind: "rows", rows };
}

export function readExactCommerceRelationship(
  database: CommerceDatabase,
  merchantId: string,
  reference: CommerceRelationshipRef,
): CommerceRelationship | undefined {
  const row = database
    .prepare(
      `SELECT * FROM commerce_relationship_relation
     WHERE merchant_id = ? AND relationship_origin = ? AND relationship_id = ?
     LIMIT 1`,
    )
    .get<RelationshipRelationViewRow>(
      merchantId,
      reference.origin,
      reference.relationshipId,
    );
  if (row === undefined) return undefined;
  const relationship = hydrateCommerceRelationshipRelationRow(
    database,
    merchantId,
    parseCommerceRelationshipRelationRow(row),
  );
  return relationshipReferenceMatches(relationship, reference)
    ? relationship
    : undefined;
}

/**
 * Brings one merchant's normalized rows, or every merchant's, to the
 * schema-owned source view, and writes only the rows that changed.
 */
export function refreshCommerceRelationshipRelation(
  database: CommerceDatabase,
  merchantId?: string,
): void {
  const ownerPredicate = merchantId === undefined ? "1 = 1" : "merchant_id = ?";
  const ownerBindings = merchantId === undefined ? [] : [merchantId];
  const desired = database
    .prepare(
      `SELECT ${RELATIONSHIP_RELATION_COLUMNS.join(", ")}
     FROM commerce_relationship_relation_source_view
     WHERE ${ownerPredicate}`,
    )
    .all<Readonly<Record<string, CommerceSqlValue>>>(...ownerBindings)
    .map((row) =>
      RELATIONSHIP_RELATION_COLUMNS.map((column) => row[column] ?? null),
    );
  syncDerivedRelationRows(
    database,
    {
      table: "commerce_relationship_relation",
      columns: RELATIONSHIP_RELATION_COLUMNS,
      keyColumns: ["merchant_id", "relationship_origin", "relationship_id"],
      ownerPredicate,
      ownerBindings,
    },
    desired,
  );
  refreshCommerceAttributeRelation(database, merchantId);
}

export function hydrateCommerceRelationshipRelationRow(
  database: CommerceDatabase,
  merchantId: string,
  row: CommerceRelationshipRelationRow,
): CommerceRelationship {
  const relationshipId = parseRelationshipId(row.relationshipId);
  const relationshipRevision = parsePositiveRevision<RelationshipRevision>(
    row.relationshipRevision,
    "relationship.revision",
  );
  if (row.relationshipOrigin === "custom") {
    if (row.definitionOrigin !== "custom")
      throw new Error("Custom relationship has a system definition");
    const definition = readCustomRelationshipDefinitionRevision(
      database,
      merchantId,
      parseRelationshipDefinitionId(row.definitionId),
      row.definitionRevision,
    );
    if (
      definition === undefined ||
      Number(definition.revision) !== row.definitionRevision
    ) {
      throw new Error(
        "Custom relationship definition is unavailable at its published revision",
      );
    }
    if (row.sensitivity !== definition.sensitivity)
      throw new Error("Custom relationship sensitivity drifted");
    if (row.source.origin === "system" && row.target.origin === "system") {
      throw new Error("Stored custom relationship has only system endpoints");
    }
    if (
      !sameEntityType(row.source, definition.sourceType) ||
      !sameEntityType(row.target, definition.targetType)
    ) {
      throw new Error("Stored custom relationship endpoint type mismatch");
    }
    const relationship: CommerceRelationship = {
      origin: "custom",
      relationshipId,
      definition: relationshipDefinitionReference(definition),
      sensitivity: definition.sensitivity,
      source: row.source,
      target: row.target,
      revision: relationshipRevision,
    };
    validateCommerceRelationshipWithLexicon(relationship, definition);
    return relationship;
  }
  if (row.definitionOrigin !== "system")
    throw new Error("System relationship has a custom definition");
  const definitionId = systemDefinitionId(row.definitionId);
  const definition = readSystemRelationshipDefinition(definitionId);
  if (
    definition === undefined ||
    Number(definition.revision) !== row.definitionRevision
  ) {
    throw new Error(
      "System relationship definition is unavailable at its published revision",
    );
  }
  if (row.sensitivity !== definition.sensitivity)
    throw new Error("System relationship sensitivity drifted");
  const source = requireSystemReference(row.source, "relationship.source");
  const target = requireSystemReference(row.target, "relationship.target");
  const provenance = readSystemEntityProvenance(database, merchantId, source);
  const relationship: CommerceRelationship = {
    origin: "system",
    relationshipId,
    definition: relationshipDefinitionReference(definition),
    sensitivity: definition.sensitivity,
    source,
    target,
    revision: relationshipRevision,
    provenance,
  };
  validateCommerceRelationshipWithLexicon(relationship, definition);
  return relationship;
}

function readSystemEntityProvenance(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
): SourceProvenance {
  const merchant = readMerchant(database, merchantId);
  if (merchant === undefined)
    throw new Error(`Merchant not found: ${merchantId}`);
  const entity = readSystemEntity(
    database,
    merchantId,
    reference,
    merchant.revision,
  );
  if (
    entity === undefined ||
    entity.reference.origin !== "system" ||
    !("provenance" in entity) ||
    entity.provenance === undefined
  ) {
    throw new Error("System relationship source entity is unavailable");
  }
  return entity.provenance;
}

function parseCommerceRelationshipRelationRow(
  row: RelationshipRelationViewRow,
): CommerceRelationshipRelationRow {
  const merchantId = normalizedText(
    row.merchant_id,
    "commerce_relationship_relation.merchant_id",
  );
  const relationshipOrigin = enumValue(
    row.relationship_origin,
    "commerce_relationship_relation.relationship_origin",
    ["system", "custom"] as const,
  );
  const relationshipId = normalizedText(
    row.relationship_id,
    "commerce_relationship_relation.relationship_id",
  );
  const definitionOrigin = enumValue(
    row.definition_origin,
    "commerce_relationship_relation.definition_origin",
    ["system", "custom"] as const,
  );
  const definitionId = normalizedText(
    row.definition_id,
    "commerce_relationship_relation.definition_id",
  );
  const sourceOrigin = enumValue(
    row.source_origin,
    "commerce_relationship_relation.source_origin",
    ["system", "custom"] as const,
  );
  const sourceTypeId = normalizedText(
    row.source_type_id,
    "commerce_relationship_relation.source_type_id",
  );
  const sourceEntityId = normalizedText(
    row.source_entity_id,
    "commerce_relationship_relation.source_entity_id",
  );
  const targetOrigin = enumValue(
    row.target_origin,
    "commerce_relationship_relation.target_origin",
    ["system", "custom"] as const,
  );
  const targetTypeId = normalizedText(
    row.target_type_id,
    "commerce_relationship_relation.target_type_id",
  );
  const targetEntityId = normalizedText(
    row.target_entity_id,
    "commerce_relationship_relation.target_entity_id",
  );
  const payloadJson = jsonText(
    row.payload_json,
    "commerce_relationship_relation.payload_json",
  );
  const provenanceJson = jsonText(
    row.provenance_json,
    "commerce_relationship_relation.provenance_json",
  );
  return {
    merchantId,
    relationshipOrigin,
    relationshipId,
    relationshipRevision: parsePositiveRevision(
      row.relationship_revision,
      "commerce_relationship_relation.relationship_revision",
    ),
    definitionOrigin,
    definitionId,
    definitionRevision: parsePositiveRevision(
      row.definition_revision,
      "commerce_relationship_relation.definition_revision",
    ),
    sensitivity: parseSensitivity(
      row.sensitivity,
      "commerce_relationship_relation.sensitivity",
    ),
    source: parseEntityRef({
      origin: sourceOrigin,
      typeId: sourceTypeId,
      entityId: sourceEntityId,
    }),
    target: parseEntityRef({
      origin: targetOrigin,
      typeId: targetTypeId,
      entityId: targetEntityId,
    }),
    payloadJson,
    provenanceJson,
  };
}

function createCommerceRelationshipRelationSourceViewSql(): string {
  return `CREATE VIEW commerce_relationship_relation_source_view (
  merchant_id,
  relationship_origin,
  relationship_id,
  relationship_revision,
  definition_origin,
  definition_id,
  definition_revision,
  sensitivity,
  source_origin,
  source_type_id,
  source_entity_id,
  target_origin,
  target_type_id,
  target_entity_id,
  payload_json,
  provenance_json
) AS
WITH canonical_transaction_entity AS (
  SELECT merchant_id, 'order' AS entity_type, resource_id AS entity_id,
         revision, occurred_at, order_snapshot_json AS payload_json,
         'commerce_order' AS resource_type
  FROM commerce_order
  UNION ALL
  SELECT merchant_id, 'fulfillment', resource_id, revision, occurred_at,
         fulfillment_snapshot_json, 'fulfillment'
  FROM fulfillment
  UNION ALL
  SELECT merchant_id, 'shipment', resource_id, revision, occurred_at,
         shipment_snapshot_json, 'shipment'
  FROM shipment
), canonical_entity AS (
  SELECT merchant_id, entity_type, entity_id, revision, occurred_at, payload_json, resource_type
  FROM canonical_transaction_entity
  UNION ALL
  SELECT merchant_id, resource_kind, resource_id, revision,
         json_extract(resource_json, '$.occurredAt'), resource_json, resource_kind
  FROM ${latestFoodServiceResources(["recipe_revision", "production_batch"])}
), canonical_transaction_edge AS (
  SELECT source.merchant_id, 'order_shipment' AS definition_id,
         source.entity_type AS source_type_id, source.entity_id AS source_entity_id,
         source.revision AS source_revision,
         source.occurred_at AS source_occurred_at,
         source.resource_type AS source_resource_type,
         target.revision AS fact_revision, target.occurred_at AS fact_occurred_at,
         target.resource_type AS fact_resource_type,
         source.payload_json AS source_payload_json,
         target.entity_type AS target_type_id, target.entity_id AS target_entity_id,
         target.payload_json AS target_payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'shipment'
   AND EXISTS (
     SELECT 1 FROM shipment
     WHERE shipment.merchant_id = source.merchant_id
       AND shipment.resource_id = target.entity_id
       AND shipment.order_id = source.entity_id
   )
  WHERE source.entity_type = 'order'
  UNION ALL
  SELECT source.merchant_id, 'order_fulfillment', source.entity_type, source.entity_id,
         source.revision, source.occurred_at, source.resource_type,
         target.revision, target.occurred_at, target.resource_type, source.payload_json,
         target.entity_type, target.entity_id, target.payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'fulfillment'
   AND EXISTS (
     SELECT 1 FROM fulfillment
     WHERE fulfillment.merchant_id = source.merchant_id
       AND fulfillment.resource_id = target.entity_id
       AND fulfillment.order_id = source.entity_id
   )
  WHERE source.entity_type = 'order'
  UNION ALL
  SELECT source.merchant_id, 'fulfillment_shipment', source.entity_type, source.entity_id,
         source.revision, source.occurred_at, source.resource_type,
         target.revision, target.occurred_at, target.resource_type, source.payload_json,
         target.entity_type, target.entity_id, target.payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'shipment'
   AND EXISTS (
     SELECT 1 FROM shipment
     WHERE shipment.merchant_id = source.merchant_id
       AND shipment.resource_id = target.entity_id
       AND shipment.fulfillment_id = source.entity_id
   )
  WHERE source.entity_type = 'fulfillment'
), canonical_production_edge AS (
  SELECT source.merchant_id, 'shipment_production_batch', source.entity_type, source.entity_id,
         source.revision, source.occurred_at, source.resource_type,
         target.revision, target.occurred_at, target.resource_type, source.payload_json,
         target.entity_type, target.entity_id, target.payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'production_batch'
   AND json_extract(target.payload_json, '$.demand.shipmentId') = source.entity_id
  WHERE source.entity_type = 'shipment'
  UNION ALL
  SELECT source.merchant_id, 'recipe_revision_production_batch', source.entity_type, source.entity_id,
         source.revision, source.occurred_at, source.resource_type,
         target.revision, target.occurred_at, target.resource_type, source.payload_json,
         target.entity_type, target.entity_id, target.payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'production_batch'
   AND COALESCE(
     json_extract(target.payload_json, '$.recipeRevisionId'),
     json_extract(target.payload_json, '$.recipe_revision_id')
   ) = source.entity_id
  WHERE source.entity_type = 'recipe_revision'
  UNION ALL
  SELECT source.merchant_id, 'production_batch_recipe_revision', source.entity_type, source.entity_id,
         source.revision, source.occurred_at, source.resource_type,
         target.revision, target.occurred_at, target.resource_type, source.payload_json,
         target.entity_type, target.entity_id, target.payload_json
  FROM canonical_entity AS source
  JOIN canonical_entity AS target
    ON target.merchant_id = source.merchant_id AND target.entity_type = 'recipe_revision'
   AND COALESCE(
     json_extract(source.payload_json, '$.recipeRevisionId'),
     json_extract(source.payload_json, '$.recipe_revision_id')
   ) = target.entity_id
  WHERE source.entity_type = 'production_batch'
), canonical_edge AS (
  SELECT * FROM canonical_transaction_edge
  UNION ALL
  SELECT * FROM canonical_production_edge
), custom_relationship AS (
  SELECT relationship.merchant_id, 'custom' AS relationship_origin,
         relationship.relationship_id, relationship.revision AS relationship_revision,
         'custom' AS definition_origin, relationship.relationship_definition_id AS definition_id,
         relationship.relationship_definition_revision AS definition_revision,
         json_extract(definition.definition_json, '$.sensitivity') AS sensitivity,
         relationship.source_origin, relationship.source_type_id,
         relationship.source_entity_id, relationship.target_origin, relationship.target_type_id,
         relationship.target_entity_id,
         json_object('relationshipId', relationship.relationship_id) AS payload_json,
         json('{}') AS provenance_json
  FROM commerce_relationship AS relationship
  JOIN relationship_definition AS definition
    ON definition.merchant_id = relationship.merchant_id
   AND definition.relationship_definition_id = relationship.relationship_definition_id
   AND definition.revision = relationship.relationship_definition_revision
   AND definition.lifecycle_state = 'published'
  WHERE relationship.lifecycle_state = 'active'
)
SELECT merchant_id, relationship_origin, relationship_id, relationship_revision,
       definition_origin, definition_id, definition_revision, sensitivity,
       source_origin, source_type_id, source_entity_id,
       target_origin, target_type_id, target_entity_id, payload_json, provenance_json
FROM custom_relationship
UNION ALL
SELECT edge.merchant_id, 'system',
       'system:' || edge.definition_id || ':' || edge.source_entity_id || ':' || edge.target_entity_id,
       edge.fact_revision, 'system', edge.definition_id, 1, 'internal',
       'system', edge.source_type_id, edge.source_entity_id,
         'system', edge.target_type_id, edge.target_entity_id,
       json_object('source', json(edge.source_payload_json), 'target', json(edge.target_payload_json)),
       json_object(
         'organisationId', merchant.external_reference,
         'integrationAccountId', 'underclerk',
         'source', 'underclerk',
         'resourceType', edge.source_resource_type,
         'resourceId', edge.source_entity_id,
         'revision', edge.source_revision,
         'occurredAt', edge.source_occurred_at,
         'observedAt', edge.source_occurred_at
       )
FROM canonical_edge AS edge
JOIN merchant ON merchant.merchant_id = edge.merchant_id;`;
}

function assertCanonicalRelationshipProvenance(
  database: CommerceDatabase,
): void {
  const invalid = database
    .prepare(
      `SELECT 1 AS present
     FROM ${latestFoodServiceResources(["recipe_revision", "production_batch"])}
       AND (
         json_type(resource.resource_json, '$.occurredAt') != 'text' OR
         length(trim(json_extract(resource.resource_json, '$.occurredAt'))) = 0
       )
     LIMIT 1`,
    )
    .get<Readonly<{ present: number }>>();
  if (invalid !== undefined)
    throw new Error(
      "Canonical relationship provenance requires a food-service occurredAt timestamp",
    );
}

function assertCommerceRelationshipRelation(
  database: CommerceDatabase,
  expectedViewSql: string,
): void {
  const view = database
    .prepare(
      `SELECT sql FROM sqlite_master
     WHERE type = 'view' AND name = 'commerce_relationship_relation_source_view'`,
    )
    .get<Readonly<{ sql: string | null }>>();
  if (
    view === undefined ||
    view.sql === null ||
    normalizeSql(view.sql) !== expectedViewSql
  ) {
    throw new Error(
      "commerce_relationship_relation source view definition drifted",
    );
  }
  assertExactRelationColumns(
    database,
    "commerce_relationship_relation",
    RELATIONSHIP_RELATION_COLUMNS,
  );
  for (const index of [
    "commerce_relationship_relation_source",
    "commerce_relationship_relation_target",
  ]) {
    if (
      !relationTableHasIndex(database, "commerce_relationship_relation", index)
    ) {
      throw new Error(
        `commerce_relationship_relation index is missing: ${index}`,
      );
    }
  }
  assertRelationshipIndexPlan(
    database,
    "source",
    "commerce_relationship_relation_source",
  );
  assertRelationshipIndexPlan(
    database,
    "target",
    "commerce_relationship_relation_target",
  );
}

function assertRelationshipIndexPlan(
  database: CommerceDatabase,
  endpoint: "source" | "target",
  expectedIndex: string,
): void {
  const endpointColumns =
    endpoint === "source"
      ? "source_origin, source_type_id, source_entity_id"
      : "target_origin, target_type_id, target_entity_id";
  if (
    !explainUsesIndex(
      database,
      `SELECT relationship_id
     FROM commerce_relationship_relation
     WHERE merchant_id = ?
       AND definition_origin = ?
       AND definition_id = ?
       AND definition_revision = ?
       AND ${endpointColumns
         .split(", ")
         .map((column) => `${column} = ?`)
         .join(" AND ")}`,
      [
        "merchant_explain",
        "system",
        "order_shipment",
        1,
        "system",
        "order",
        "order_explain",
      ],
      expectedIndex,
    )
  ) {
    throw new Error(
      `commerce_relationship_relation ${endpoint} EXPLAIN does not use ${expectedIndex}`,
    );
  }
}

function toCommerceSqlValue(
  value: CommerceSqliteBinding,
): CommerceSqlValue {
  if (typeof value !== "bigint") return value;
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(
      "SQLite relationship binding exceeds the safe integer range",
    );
  }
  return Number(value);
}

function normalizedText(value: unknown, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const normalized = normalizedText(value, field);
  const entry = allowed.find((candidate) => candidate === normalized);
  if (entry === undefined) throw new Error(`${field} is unsupported`);
  return entry;
}

function jsonText(value: unknown, field: string): string {
  const text = normalizedText(value, field);
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${field} must contain valid JSON`);
  }
  return text;
}

function sameEntityType(
  reference: CommerceEntityRef,
  typeId: VariantBy<RelationshipDefinition, "origin", "custom">["sourceType"],
): boolean {
  return (
    reference.origin === typeId.origin && reference.typeId === typeId.typeId
  );
}

function relationshipReferenceMatches(
  relationship: CommerceRelationship,
  reference: CommerceRelationshipRef,
): boolean {
  return (
    relationship.origin === reference.origin &&
    relationship.relationshipId === reference.relationshipId &&
    sameRelationshipDefinitionRef(
      relationship.definition,
      reference.definition,
    ) &&
    Number(relationship.revision) === Number(reference.revision)
  );
}

function requireSystemReference(
  reference: CommerceEntityRef,
  field: string,
): SystemCommerceEntityRef {
  if (reference.origin !== "system")
    throw new Error(`${field} must be a system entity reference`);
  return reference;
}

function systemDefinitionId(value: string): SystemRelationshipDefinitionKind {
  switch (value) {
    case "order_shipment":
    case "order_fulfillment":
    case "fulfillment_shipment":
    case "recipe_revision_production_batch":
    case "production_batch_recipe_revision":
    case "shipment_production_batch":
      return value;
    default:
      throw new Error(`Unsupported system relationship definition: ${value}`);
  }
}
