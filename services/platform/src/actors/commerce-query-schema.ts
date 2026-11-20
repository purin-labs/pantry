import { COMMERCE_ENTITY_ATTRIBUTE_RELATION } from "@purin-labs/commerce-query-sqlite";
import { normalizeCommerceUnicodeV1 } from "@purin-labs/commerce-contracts/unicode";
import type {
  CommerceSensitivity,
  SystemCommerceEntityKind,
  SystemRelationshipDefinitionKind,
} from "@purin-labs/commerce-contracts";
import {
  runSchemaMigrations,
  type SchemaTransaction,
} from "./schema-migrations";
import {
  COMMERCE_QUERY_SCHEMA_V5,
  execSchemaStatements,
} from "./commerce-schema-baseline";
import type { Result } from "../result";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";
import { isCommerceSensitivity } from "../commerce/sensitivity";
const COMMERCE_RELATIONSHIP_INDEX_TABLE =
  "commerce_relationship_relation_index";
const COMMERCE_ATTRIBUTE_INDEX_TABLE =
  "commerce_entity_attribute_relation_index";
const COMMERCE_ATTRIBUTE_FILTER_INDEX =
  "commerce_entity_attribute_relation_filter_idx";
const COMMERCE_ATTRIBUTE_ORDER_INDEX =
  "commerce_entity_attribute_relation_order_idx";

/** The only system attributes materialized into the conformance-checked Blotter index. */
export function commerceBlotterSystemAttributeIds(
  entityType: SystemCommerceEntityKind,
): readonly string[] {
  return entityType === "stock_policy"
    ? ["lifecycle", "low_stock"]
    : ["lifecycle"];
}

const COMMERCE_QUERY_SCHEMA_PLAN = {
  key: "commerce_query",
  currentVersion: 5,
  preservedTables: [] as const,
  baseline: {
    version: 5,
    apply: (sql: SqlStorage) =>
      execSchemaStatements(sql, COMMERCE_QUERY_SCHEMA_V5),
    validate: validateCommerceAttributeRelation,
  },
  steps: [],
} as const;

export type CommerceEntityRelationRow = Readonly<{
  merchant_id: string;
  entity_origin: "system";
  entity_type: string;
  entity_id: string;
  revision: number;
  updated_at: number;
  display_name: string;
  display_name_folded: string;
  search_text_folded: string;
  payload_json: string;
}>;

type CommerceEntityRelationRowError = Readonly<{
  readonly code: "commerce_entity_relation_row_invalid";
  readonly field: string;
}>;

export type CommerceRelationshipRelationRow = Readonly<{
  merchant_id: string;
  relationship_origin: "system";
  relationship_id: string;
  relationship_revision: number;
  definition_origin: "system";
  definition_id: SystemRelationshipDefinitionKind;
  definition_revision: number;
  sensitivity: CommerceSensitivity;
  source_origin: "system";
  source_type_id: SystemCommerceEntityKind;
  source_entity_id: string;
  target_origin: "system";
  target_type_id: SystemCommerceEntityKind;
  target_entity_id: string;
  payload_json: string;
  provenance_json: string;
}>;

type CommerceRelationshipRelationRowError = Readonly<{
  readonly code: "commerce_relationship_relation_row_invalid";
  readonly field: string;
}>;

type CommerceRelationshipRelationWrite = CommerceRelationshipRelationRow;

type CommerceRelationText = Readonly<{
  readonly displayNameFolded: string;
  readonly searchTextFolded: string;
}>;

type CommerceRelationTextError = Readonly<{
  readonly code: "commerce_unicode_normalization_failed";
}>;

/** Materializes relation text with the contracts Rust Unicode primitive. */
export function materializeCommerceRelationText(
  displayName: string,
  searchText: string,
): Result<CommerceRelationText, CommerceRelationTextError> {
  const displayNameFolded = normalizeCommerceUnicode(displayName);
  if (displayNameFolded === null) {
    return {
      ok: false,
      error: { code: "commerce_unicode_normalization_failed" },
    };
  }
  const searchTextFolded = normalizeCommerceUnicode(searchText);
  if (searchTextFolded === null) {
    return {
      ok: false,
      error: { code: "commerce_unicode_normalization_failed" },
    };
  }
  return { ok: true, value: { displayNameFolded, searchTextFolded } };
}

export function parseCommerceEntityRelationRow(
  raw: unknown,
): Result<CommerceEntityRelationRow, CommerceEntityRelationRowError> {
  if (!isRecord(raw)) return invalidRelationRow("row");
  const merchantId = normalizedText(raw.merchant_id);
  if (merchantId === null) return invalidRelationRow("merchant_id");
  if (raw.entity_origin !== "system")
    return invalidRelationRow("entity_origin");
  const entityType = normalizedText(raw.entity_type);
  if (entityType === null) return invalidRelationRow("entity_type");
  const entityId = normalizedText(raw.entity_id);
  if (entityId === null) return invalidRelationRow("entity_id");
  if (!isPositiveInteger(raw.revision)) return invalidRelationRow("revision");
  if (!isNonNegativeInteger(raw.updated_at))
    return invalidRelationRow("updated_at");
  const displayName = normalizedText(raw.display_name);
  if (displayName === null) return invalidRelationRow("display_name");
  const displayNameFolded = normalizedText(raw.display_name_folded);
  if (displayNameFolded === null)
    return invalidRelationRow("display_name_folded");
  const searchTextFolded = normalizedText(raw.search_text_folded);
  if (searchTextFolded === null)
    return invalidRelationRow("search_text_folded");
  const payloadJson = normalizedText(raw.payload_json);
  if (payloadJson === null || !isJson(payloadJson)) {
    return invalidRelationRow("payload_json");
  }
  return {
    ok: true,
    value: {
      merchant_id: merchantId,
      entity_origin: "system",
      entity_type: entityType,
      entity_id: entityId,
      revision: raw.revision,
      updated_at: raw.updated_at,
      display_name: displayName,
      display_name_folded: displayNameFolded,
      search_text_folded: searchTextFolded,
      payload_json: payloadJson,
    },
  };
}

export function parseCommerceRelationshipRelationRow(
  raw: unknown,
): Result<
  CommerceRelationshipRelationRow,
  CommerceRelationshipRelationRowError
> {
  if (!isRecord(raw)) return invalidRelationshipRow("row");
  const owner = normalizedText(raw.merchant_id);
  if (owner === null) return invalidRelationshipRow("merchant_id");
  if (raw.relationship_origin !== "system")
    return invalidRelationshipRow("relationship_origin");
  const relationshipId = normalizedText(raw.relationship_id);
  if (relationshipId === null) return invalidRelationshipRow("relationship_id");
  if (!isPositiveInteger(raw.relationship_revision))
    return invalidRelationshipRow("relationship_revision");
  if (raw.definition_origin !== "system")
    return invalidRelationshipRow("definition_origin");
  if (!isSystemRelationshipDefinitionKind(raw.definition_id))
    return invalidRelationshipRow("definition_id");
  if (!isPositiveInteger(raw.definition_revision))
    return invalidRelationshipRow("definition_revision");
  if (!isCommerceSensitivity(raw.sensitivity))
    return invalidRelationshipRow("sensitivity");
  if (raw.source_origin !== "system")
    return invalidRelationshipRow("source_origin");
  if (!isSystemCommerceEntityKind(raw.source_type_id))
    return invalidRelationshipRow("source_type_id");
  const sourceId = normalizedText(raw.source_entity_id);
  if (sourceId === null) return invalidRelationshipRow("source_entity_id");
  if (raw.target_origin !== "system")
    return invalidRelationshipRow("target_origin");
  if (!isSystemCommerceEntityKind(raw.target_type_id))
    return invalidRelationshipRow("target_type_id");
  const targetId = normalizedText(raw.target_entity_id);
  if (targetId === null) return invalidRelationshipRow("target_entity_id");
  const payloadJson = normalizedText(raw.payload_json);
  if (payloadJson === null || !isJson(payloadJson))
    return invalidRelationshipRow("payload_json");
  const provenanceJson = normalizedText(raw.provenance_json);
  if (provenanceJson === null || !isJson(provenanceJson))
    return invalidRelationshipRow("provenance_json");
  return {
    ok: true,
    value: {
      merchant_id: owner,
      relationship_origin: "system",
      relationship_id: relationshipId,
      relationship_revision: raw.relationship_revision,
      definition_origin: "system",
      definition_id: raw.definition_id,
      definition_revision: raw.definition_revision,
      sensitivity: raw.sensitivity,
      source_origin: "system",
      source_type_id: raw.source_type_id,
      source_entity_id: sourceId,
      target_origin: "system",
      target_type_id: raw.target_type_id,
      target_entity_id: targetId,
      payload_json: payloadJson,
      provenance_json: provenanceJson,
    },
  };
}

export function createCommerceQuerySchema(sql: SqlStorage): void;
export function createCommerceQuerySchema(
  sql: SqlStorage,
  transaction: SchemaTransaction,
): void;
export function createCommerceQuerySchema(
  sql: SqlStorage,
  transaction?: SchemaTransaction,
): void {
  runSchemaMigrations(
    sql,
    COMMERCE_QUERY_SCHEMA_PLAN,
    transaction ?? transactionFromSql(sql),
  );
}

function transactionFromSql(sql: SqlStorage): SchemaTransaction {
  if (
    !("transactionSync" in sql) ||
    typeof sql.transactionSync !== "function"
  ) {
    throw new Error("commerce_query_schema_transaction_missing");
  }
  return sql.transactionSync.bind(sql);
}

function validateCommerceAttributeRelation(sql: SqlStorage): void {
  const view = sql
    .exec<{ readonly sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = '${COMMERCE_ENTITY_ATTRIBUTE_RELATION}'`,
    )
    .toArray()[0];
  if (
    view?.sql === null ||
    view?.sql === undefined ||
    !view.sql.toLowerCase().includes(`from ${COMMERCE_ATTRIBUTE_INDEX_TABLE}`)
  ) {
    throw new Error("commerce_query_attribute_relation_view_invalid");
  }
  const columns = sql
    .exec<{ readonly name: string }>(
      `PRAGMA table_info(${COMMERCE_ENTITY_ATTRIBUTE_RELATION})`,
    )
    .toArray()
    .map((row) => row.name);
  const expectedColumns = [
    "merchant_id",
    "subject_kind",
    "entity_origin",
    "entity_type",
    "entity_id",
    "list_id",
    "entry_id",
    "entity_revision",
    "attribute_id",
    "definition_revision",
    "value_kind",
    "comparable_text",
    "comparable_integer",
    "comparable_real",
    "comparable_boolean",
  ];
  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => column !== expectedColumns[index])
  ) {
    throw new Error("commerce_query_attribute_relation_columns_invalid");
  }
  const indexes = sql
    .exec<{ readonly name: string }>(
      `PRAGMA index_list(${COMMERCE_ATTRIBUTE_INDEX_TABLE})`,
    )
    .toArray()
    .map((row) => row.name);
  if (
    !indexes.includes(COMMERCE_ATTRIBUTE_FILTER_INDEX) ||
    !indexes.includes(COMMERCE_ATTRIBUTE_ORDER_INDEX)
  ) {
    throw new Error("commerce_query_attribute_relation_index_missing");
  }
  const details = sql
    .exec<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT attribute_id FROM ${COMMERCE_ENTITY_ATTRIBUTE_RELATION}
       WHERE merchant_id = ? AND subject_kind = 'entity'
         AND entity_origin = 'system' AND entity_type = ? AND entity_id = ?
         AND list_id = '' AND entry_id = '' AND attribute_id = ?`,
      "merchant_explain",
      "order",
      "order_explain",
      "lifecycle",
    )
    .toArray()
    .map((row) => row.detail);
  if (
    !details.some((detail) => detail.includes(COMMERCE_ATTRIBUTE_FILTER_INDEX))
  ) {
    throw new Error("commerce_query_attribute_relation_explain_index_missing");
  }
}

export function rebuildCommerceRelationshipRelationsForOwner(
  sql: SqlStorage,
  merchantId: string,
): void {
  sql.exec(
    `DELETE FROM ${COMMERCE_RELATIONSHIP_INDEX_TABLE} WHERE merchant_id = ?`,
    merchantId,
  );
  const projections = sql
    .exec<
      Readonly<{
        readonly integrationAccountId: string;
        readonly projectionKind: string;
        readonly canonicalId: string;
        readonly revision: number;
        readonly projectionJson: string;
      }>
    >(
      `SELECT integration_account_id AS integrationAccountId,
            projection_kind AS projectionKind,
            canonical_id AS canonicalId,
            revision,
            projection_json AS projectionJson
       FROM commerce_projection
      WHERE integration_account_id = ?`,
      merchantId,
    )
    .toArray();
  for (const projection of projections) {
    const relationships = materializeBlotterRelationshipRows(projection);
    for (const relationship of relationships) {
      writeCommerceRelationshipRelation(sql, relationship);
    }
  }
  rebuildCommerceAttributeRelationsForOwner(sql, merchantId);
}

type CommerceAttributeRelationWrite = Readonly<{
  merchant_id: string;
  subject_kind: "entity" | "list_entry";
  entity_origin: "system";
  entity_type: string;
  entity_id: string;
  list_id: string;
  entry_id: string;
  entity_revision: number;
  attribute_id: string;
  definition_revision: number;
  value_kind: string;
  comparable_text: string | null;
  comparable_integer: number | null;
  comparable_real: number | null;
  comparable_boolean: number | null;
}>;

function rebuildCommerceAttributeRelationsForOwner(
  sql: SqlStorage,
  merchantId: string,
): void {
  sql.exec(
    `DELETE FROM ${COMMERCE_ATTRIBUTE_INDEX_TABLE} WHERE merchant_id = ?`,
    merchantId,
  );
  const projections = sql
    .exec<
      Readonly<{
        readonly integrationAccountId: string;
        readonly projectionKind: string;
        readonly canonicalId: string;
        readonly revision: number;
        readonly projectionJson: string;
      }>
    >(
      `SELECT integration_account_id AS integrationAccountId,
            projection_kind AS projectionKind, canonical_id AS canonicalId,
            revision, projection_json AS projectionJson
       FROM commerce_projection
      WHERE integration_account_id = ?`,
      merchantId,
    )
    .toArray();
  for (const projection of projections) {
    const body = projectionBody(projection.projectionJson);
    if (body === null || !isPositiveInteger(projection.revision)) continue;
    const entityType = entityTypeForProjectionKind(projection.projectionKind);
    if (entityType === null) continue;
    const lifecycle = lifecycleAttribute(body.lifecycle);
    if (lifecycle !== null) {
      writeCommerceAttributeRelation(sql, {
        merchant_id: merchantId,
        subject_kind: "entity",
        entity_origin: "system",
        entity_type: entityType,
        entity_id: projection.canonicalId,
        list_id: "",
        entry_id: "",
        entity_revision: projection.revision,
        attribute_id: "lifecycle",
        definition_revision: 1,
        value_kind: "status",
        comparable_text: lifecycle,
        comparable_integer: null,
        comparable_real: null,
        comparable_boolean: null,
      });
    }
    if (projection.projectionKind === "stock_policy") {
      writeCommerceAttributeRelation(sql, {
        merchant_id: merchantId,
        subject_kind: "entity",
        entity_origin: "system",
        entity_type: entityType,
        entity_id: projection.canonicalId,
        list_id: "",
        entry_id: "",
        entity_revision: projection.revision,
        attribute_id: "low_stock",
        definition_revision: 1,
        value_kind: "boolean",
        comparable_text: null,
        comparable_integer: null,
        comparable_real: null,
        comparable_boolean: isLowStock(sql, merchantId, body) ? 1 : 0,
      });
    }
  }
}

function writeCommerceAttributeRelation(
  sql: SqlStorage,
  attribute: CommerceAttributeRelationWrite,
): void {
  sql.exec(
    `INSERT INTO ${COMMERCE_ATTRIBUTE_INDEX_TABLE} (
       merchant_id, subject_kind, entity_origin, entity_type, entity_id,
       list_id, entry_id, entity_revision, attribute_id, definition_revision,
       value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (
       merchant_id, subject_kind, entity_origin, entity_type, entity_id,
       list_id, entry_id, entity_revision, attribute_id
     ) DO UPDATE SET definition_revision = excluded.definition_revision,
       value_kind = excluded.value_kind,
       comparable_text = excluded.comparable_text,
       comparable_integer = excluded.comparable_integer,
       comparable_real = excluded.comparable_real,
       comparable_boolean = excluded.comparable_boolean`,
    attribute.merchant_id,
    attribute.subject_kind,
    attribute.entity_origin,
    attribute.entity_type,
    attribute.entity_id,
    attribute.list_id,
    attribute.entry_id,
    attribute.entity_revision,
    attribute.attribute_id,
    attribute.definition_revision,
    attribute.value_kind,
    attribute.comparable_text,
    attribute.comparable_integer,
    attribute.comparable_real,
    attribute.comparable_boolean,
  );
}

function entityTypeForProjectionKind(value: string): string | null {
  return value === "commerce_order"
    ? "order"
    : isSystemEntityType(value)
      ? value
      : null;
}

function isSystemEntityType(value: string): boolean {
  return (
    value === "product" ||
    value === "sellable_variant" ||
    value === "inventory_item" ||
    value === "location" ||
    value === "sales_channel" ||
    value === "offer" ||
    value === "inventory_position" ||
    value === "inventory_movement" ||
    value === "inventory_lot" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment" ||
    value === "menu" ||
    value === "modifier_group_revision" ||
    value === "recipe_revision" ||
    value === "preparation_station" ||
    value === "preparation_ticket" ||
    value === "production_batch" ||
    value === "stock_policy"
  );
}

function lifecycleAttribute(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    isRecord(value) &&
    typeof value.state === "string" &&
    value.state.length > 0
  )
    return value.state;
  return null;
}

function isLowStock(
  sql: SqlStorage,
  merchantId: string,
  policy: Record<string, unknown>,
): boolean {
  const replenishment = isRecord(policy.replenishment)
    ? policy.replenishment
    : null;
  if (replenishment === null || replenishment.kind !== "threshold")
    return false;
  const reorderPoint = quantity(replenishment.reorderPoint);
  if (
    reorderPoint === null ||
    typeof policy.inventoryItemId !== "string" ||
    typeof policy.locationId !== "string"
  )
    return false;
  const row = sql
    .exec<{ readonly projectionJson: string }>(
      `SELECT projection_json AS projectionJson
       FROM commerce_projection
      WHERE integration_account_id = ? AND projection_kind = 'inventory_position'
        AND json_extract(projection_json, '$.projection.inventoryItemId') = ?
        AND json_extract(projection_json, '$.projection.locationId') = ?
      ORDER BY revision DESC LIMIT 1`,
      merchantId,
      policy.inventoryItemId,
      policy.locationId,
    )
    .toArray()[0];
  if (row === undefined) return false;
  const position = projectionBody(row.projectionJson);
  const balance =
    position !== null && isRecord(position.balance) ? position.balance : null;
  const available = balance === null ? null : quantity(balance.available);
  return (
    available !== null &&
    available.unit === reorderPoint.unit &&
    available.scale === reorderPoint.scale &&
    available.amount <= reorderPoint.amount
  );
}

type CommerceQuantity = Readonly<{
  amount: number;
  scale: number;
  unit: string;
}>;

function quantity(value: unknown): CommerceQuantity | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.amount) ||
    !isNonNegativeInteger(value.scale) ||
    typeof value.unit !== "string"
  )
    return null;
  return { amount: value.amount, scale: value.scale, unit: value.unit };
}

function materializeBlotterRelationshipRows(
  input: Readonly<{
    readonly integrationAccountId: string;
    readonly projectionKind: string;
    readonly canonicalId: string;
    readonly revision: number;
    readonly projectionJson: string;
  }>,
): readonly CommerceRelationshipRelationWrite[] {
  const body = projectionBody(input.projectionJson);
  if (body === null || !isPositiveInteger(input.revision)) {
    throw new Error("commerce_relationship_relation_source_invalid");
  }
  const provenance = body.provenance;
  const edges: Array<
    Readonly<{
      readonly definitionId: SystemRelationshipDefinitionKind;
      readonly sourceTypeId: SystemCommerceEntityKind;
      readonly sourceEntityId: string;
      readonly targetTypeId: SystemCommerceEntityKind;
      readonly targetEntityId: string;
    }>
  > = [];
  switch (input.projectionKind) {
    case "fulfillment":
      addProjectionEdge(
        edges,
        "order_fulfillment",
        "order",
        body.orderId,
        "fulfillment",
        input.canonicalId,
      );
      break;
    case "shipment":
      addProjectionEdge(
        edges,
        "order_shipment",
        "order",
        body.orderId,
        "shipment",
        input.canonicalId,
      );
      addProjectionEdge(
        edges,
        "fulfillment_shipment",
        "fulfillment",
        body.fulfillmentId,
        "shipment",
        input.canonicalId,
      );
      break;
    case "production_batch":
      addProjectionEdge(
        edges,
        "recipe_revision_production_batch",
        "recipe_revision",
        body.recipeId,
        "production_batch",
        input.canonicalId,
      );
      if (isRecord(body.demand) && body.demand.kind === "shipment") {
        addProjectionEdge(
          edges,
          "shipment_production_batch",
          "shipment",
          body.demand.shipmentId,
          "production_batch",
          input.canonicalId,
        );
      }
      break;
    default:
      break;
  }
  if (edges.length === 0) return [];
  if (!isRecord(provenance) || !isJsonValue(provenance)) {
    throw new Error("commerce_relationship_relation_provenance_invalid");
  }
  return edges.map((edge) => {
    const relationshipId = `system:${edge.definitionId}:${edge.sourceEntityId}:${edge.targetEntityId}`;
    const payload = {
      relationshipId,
      relationshipRevision: input.revision,
      definition: {
        origin: "system",
        definitionId: edge.definitionId,
        revision: 1,
      },
      source: {
        origin: "system",
        typeId: edge.sourceTypeId,
        entityId: edge.sourceEntityId,
      },
      target: {
        origin: "system",
        typeId: edge.targetTypeId,
        entityId: edge.targetEntityId,
      },
    };
    return {
      merchant_id: input.integrationAccountId,
      relationship_origin: "system",
      relationship_id: relationshipId,
      relationship_revision: input.revision,
      definition_origin: "system",
      definition_id: edge.definitionId,
      definition_revision: 1,
      sensitivity: "internal",
      source_origin: "system",
      source_type_id: edge.sourceTypeId,
      source_entity_id: edge.sourceEntityId,
      target_origin: "system",
      target_type_id: edge.targetTypeId,
      target_entity_id: edge.targetEntityId,
      payload_json: JSON.stringify(payload),
      provenance_json: JSON.stringify(provenance),
    } satisfies CommerceRelationshipRelationWrite;
  });
}

function writeCommerceRelationshipRelation(
  sql: SqlStorage,
  relationship: CommerceRelationshipRelationWrite,
): void {
  sql.exec(
    `INSERT INTO ${COMMERCE_RELATIONSHIP_INDEX_TABLE} (
       merchant_id, relationship_origin, relationship_id, relationship_revision,
       definition_origin, definition_id, definition_revision, sensitivity,
       source_origin, source_type_id, source_entity_id,
       target_origin, target_type_id, target_entity_id, payload_json, provenance_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, relationship_origin, relationship_id) DO UPDATE SET
       relationship_revision = excluded.relationship_revision,
       definition_origin = excluded.definition_origin,
       definition_id = excluded.definition_id,
       definition_revision = excluded.definition_revision,
       sensitivity = excluded.sensitivity,
       source_origin = excluded.source_origin,
       source_type_id = excluded.source_type_id,
       source_entity_id = excluded.source_entity_id,
       target_origin = excluded.target_origin,
       target_type_id = excluded.target_type_id,
       target_entity_id = excluded.target_entity_id,
       payload_json = excluded.payload_json,
       provenance_json = excluded.provenance_json`,
    relationship.merchant_id,
    relationship.relationship_origin,
    relationship.relationship_id,
    relationship.relationship_revision,
    relationship.definition_origin,
    relationship.definition_id,
    relationship.definition_revision,
    relationship.sensitivity,
    relationship.source_origin,
    relationship.source_type_id,
    relationship.source_entity_id,
    relationship.target_origin,
    relationship.target_type_id,
    relationship.target_entity_id,
    relationship.payload_json,
    relationship.provenance_json,
  );
}

function addProjectionEdge(
  edges: Array<
    Readonly<{
      readonly definitionId: SystemRelationshipDefinitionKind;
      readonly sourceTypeId: SystemCommerceEntityKind;
      readonly sourceEntityId: string;
      readonly targetTypeId: SystemCommerceEntityKind;
      readonly targetEntityId: string;
    }>
  >,
  definitionId: SystemRelationshipDefinitionKind,
  sourceTypeId: SystemCommerceEntityKind,
  sourceEntityId: unknown,
  targetTypeId: SystemCommerceEntityKind,
  targetEntityId: unknown,
): void {
  if (
    typeof sourceEntityId !== "string" ||
    sourceEntityId.length === 0 ||
    typeof targetEntityId !== "string" ||
    targetEntityId.length === 0
  ) {
    return;
  }
  edges.push({
    definitionId,
    sourceTypeId,
    sourceEntityId,
    targetTypeId,
    targetEntityId,
  });
}

function projectionBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && isRecord(parsed.projection)
      ? parsed.projection
      : null;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeCommerceUnicode(value: string): string | null {
  return normalizeCommerceUnicodeV1(value);
}

function invalidRelationRow(
  field: string,
): Result<never, CommerceEntityRelationRowError> {
  return {
    ok: false,
    error: { code: "commerce_entity_relation_row_invalid", field },
  };
}

function invalidRelationshipRow(
  field: string,
): Result<never, CommerceRelationshipRelationRowError> {
  return {
    ok: false,
    error: { code: "commerce_relationship_relation_row_invalid", field },
  };
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isSystemRelationshipDefinitionKind(
  value: unknown,
): value is SystemRelationshipDefinitionKind {
  return (
    value === "order_shipment" ||
    value === "order_fulfillment" ||
    value === "fulfillment_shipment" ||
    value === "recipe_revision_production_batch" ||
    value === "production_batch_recipe_revision" ||
    value === "shipment_production_batch"
  );
}

function isSystemCommerceEntityKind(
  value: unknown,
): value is SystemCommerceEntityKind {
  return (
    value === "location" ||
    value === "product" ||
    value === "sellable_variant" ||
    value === "offer" ||
    value === "inventory_item" ||
    value === "stock_policy" ||
    value === "menu" ||
    value === "recipe_revision" ||
    value === "preparation_ticket" ||
    value === "production_batch" ||
    value === "order" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment" ||
    value === "sales_channel" ||
    value === "inventory_position" ||
    value === "inventory_movement" ||
    value === "inventory_lot" ||
    value === "modifier_group_revision" ||
    value === "preparation_station"
  );
}
