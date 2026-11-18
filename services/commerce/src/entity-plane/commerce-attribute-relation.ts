import type {
  AttributeDefinition,
  AttributeValue,
  AttributeValueAssignment,
  CommerceEntityRef,
  CommerceOrderingValue,
  SystemCommerceEntityRef,
} from "@seams/commerce-contracts";
import {
  CURRENCY_MINOR_UNITS,
  parseFoodServiceObservation,
  parsePayment,
} from "@seams/commerce-client";
import type { CommerceDatabase, CommerceSqlValue } from "../database.ts";
import { storedValue, type StoredAttributeRow } from "./entities.ts";
import {
  parseAttributeAssignment,
  parseAttributeDefinition,
  parseEntityRef,
  parseAttributeValue,
} from "./parsers.ts";
import {
  assertExactRelationColumns,
  explainUsesIndex,
  normalizeRelationSql as normalizeSql,
  relationTableHasIndex,
  syncDerivedRelationRows,
} from "./relation-schema.ts";
import {
  FOOD_SERVICE_ENTITY_ROWS,
  foodServiceLatestRevision,
  readLatestFoodServiceResourceJson,
} from "../plugins/food-service/index.ts";
import { assertNever, isRecord, parseJson } from "@seams/std";
import { allowedPriceRange } from "../commerce-authority/offer-pricing.ts";

const ATTRIBUTE_RELATION_SCHEMA_VERSION = 7;

type SystemKind = SystemCommerceEntityRef["typeId"];

const OFFER_PRICE_POLICY_STATES = ["disabled", "enabled"] as const;
const OFFER_PRICE_CURRENCIES = Object.keys(CURRENCY_MINOR_UNITS);

type AttributeRelationSchemaRow = Readonly<{
  version: number;
  viewSql: string | null;
}>;

type EntityRelationSourceRow = Readonly<{
  merchantId: string;
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
  revision: number;
}>;

type LifecycleRow = Readonly<{ lifecycleState: string }>;
type InventoryPositionBalanceRow = Readonly<{
  availableAmount: number;
  quantityScale: number;
  quantityUnit: string;
}>;
type AttributeOrderingRow = Readonly<{
  valueKind: string;
  comparableText: string | null;
  comparableInteger: number | null;
  comparableReal: number | null;
  comparableBoolean: number | null;
}>;

type CommerceAttributeRelationSubject = Readonly<{
  merchantId: string;
  subjectKind: "entity" | "list_entry";
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
  listId: string;
  entryId: string;
}>;

type ListEntrySourceRow = Readonly<{
  merchantId: string;
  listId: string;
  entryId: string;
  entryRevision: number;
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
}>;

type ListEntryAttributeRow = StoredAttributeRow &
  Readonly<{
    entryId: string;
    entryRevision: number;
    definitionRevision: number;
  }>;

type EntityAttributeRow = StoredAttributeRow &
  Readonly<{ definitionRevision: number }>;

const ATTRIBUTE_RELATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_entity_attribute_relation_schema (
  relation_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  view_sql TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_entity_attribute_relation_index (
  merchant_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entity', 'list_entry')),
  entity_origin TEXT NOT NULL CHECK (entity_origin IN ('system', 'custom')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL CHECK (entity_revision > 0),
  attribute_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  value_kind TEXT NOT NULL,
  comparable_text TEXT,
  comparable_integer INTEGER,
  comparable_real REAL,
  comparable_boolean INTEGER CHECK (comparable_boolean IS NULL OR comparable_boolean IN (0, 1)),
  PRIMARY KEY (
    merchant_id, subject_kind, entity_origin, entity_type, entity_id,
    list_id, entry_id, entity_revision, attribute_id
  )
) STRICT;

CREATE INDEX IF NOT EXISTS commerce_entity_attribute_relation_filter_idx
  ON commerce_entity_attribute_relation_index (
    merchant_id, subject_kind, entity_origin, entity_type, entity_id,
    list_id, entry_id, attribute_id, value_kind,
    comparable_text, comparable_integer, comparable_real, comparable_boolean
  );
CREATE INDEX IF NOT EXISTS commerce_entity_attribute_relation_order_idx
  ON commerce_entity_attribute_relation_index (
    merchant_id, subject_kind, entity_origin, entity_type,
    attribute_id, comparable_text, comparable_integer, comparable_real,
    comparable_boolean, entity_id
  );
`;

const ATTRIBUTE_RELATION_COLUMNS = [
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
] as const;

const ATTRIBUTE_RELATION_KEY_COLUMNS = [
  "merchant_id",
  "subject_kind",
  "entity_origin",
  "entity_type",
  "entity_id",
  "list_id",
  "entry_id",
  "entity_revision",
  "attribute_id",
] as const;

export function initializeCommerceAttributeRelation(
  database: CommerceDatabase,
): void {
  database.transaction(() => {
    database.exec(ATTRIBUTE_RELATION_SCHEMA);
    const expectedViewSql = normalizeSql(createAttributeRelationViewSql());
    const installed = database
      .prepare(
        `SELECT version, view_sql AS viewSql
       FROM commerce_entity_attribute_relation_schema
       WHERE relation_name = 'commerce_entity_attribute_relation'`,
      )
      .get<AttributeRelationSchemaRow>();
    // Versions 1 and 7 share the materialized relation; normalize its persisted marker.
    if (
      installed !== undefined &&
      installed.version !== 1 &&
      installed.version !== ATTRIBUTE_RELATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported commerce_entity_attribute_relation schema version: ${installed.version}`,
      );
    }
    const currentView = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'commerce_entity_attribute_relation'`,
      )
      .get<Readonly<{ sql: string | null }>>();
    const viewNeedsInstall =
      currentView === undefined ||
      currentView.sql === null ||
      installed?.viewSql !== expectedViewSql ||
      normalizeSql(currentView.sql) !== expectedViewSql;
    if (viewNeedsInstall) {
      database.exec("DROP VIEW IF EXISTS commerce_entity_attribute_relation");
      database.exec(createAttributeRelationViewSql());
    }
    if (installed === undefined) {
      database
        .prepare(
          `INSERT INTO commerce_entity_attribute_relation_schema (relation_name, version, view_sql)
         VALUES ('commerce_entity_attribute_relation', ?, ?)`,
        )
        .run(ATTRIBUTE_RELATION_SCHEMA_VERSION, expectedViewSql);
    } else if (
      viewNeedsInstall ||
      installed.version !== ATTRIBUTE_RELATION_SCHEMA_VERSION
    ) {
      database
        .prepare(
          `UPDATE commerce_entity_attribute_relation_schema SET version = ?, view_sql = ?
         WHERE relation_name = 'commerce_entity_attribute_relation'`,
        )
        .run(ATTRIBUTE_RELATION_SCHEMA_VERSION, expectedViewSql);
    }
    assertAttributeRelation(database, expectedViewSql);
  });
}

/**
 * Brings one merchant's attribute rows, or every merchant's, to the current
 * entities and active list entries, and writes only the rows that changed.
 */
export function refreshCommerceAttributeRelation(
  database: CommerceDatabase,
  merchantId?: string,
): void {
  const ownerPredicate = merchantId === undefined ? "1 = 1" : "merchant_id = ?";
  const ownerBindings = merchantId === undefined ? [] : [merchantId];
  const desired: (readonly CommerceSqlValue[])[] = [];
  const collect = (assignment: AttributeInsert): void => {
    desired.push(attributeRelationRow(assignment));
  };
  const entities = database
    .prepare(
      `SELECT merchant_id AS merchantId, entity_origin AS entityOrigin,
            entity_type AS entityType, entity_id AS entityId, revision
     FROM commerce_entity_relation_index
     WHERE ${ownerPredicate}
     ORDER BY merchant_id, entity_origin, entity_type, entity_id`,
    )
    .all<EntityRelationSourceRow>(...ownerBindings);
  for (const row of entities) {
    const reference = parseEntityRef({
      origin: row.entityOrigin,
      typeId: row.entityType,
      entityId: row.entityId,
    });
    const attributes = readEntityAttributeRows(database, row, reference);
    for (const assignment of attributes) {
      collect({
        merchantId: row.merchantId,
        subjectKind: "entity",
        entityOrigin: row.entityOrigin,
        entityType: row.entityType,
        entityId: row.entityId,
        listId: "",
        entryId: "",
        entityRevision: row.revision,
        attributeId: assignment.attributeId,
        definitionRevision: assignment.definitionRevision,
        value: parseAttributeValue(storedValue(assignment)),
      });
    }
  }
  const entries = database
    .prepare(
      `SELECT merchant_id AS merchantId, list_id AS listId, entry_id AS entryId,
            revision AS entryRevision, entity_origin AS entityOrigin,
            entity_type_id AS entityType, entity_id AS entityId
     FROM commerce_list_entry
     WHERE lifecycle_state = 'active' AND ${merchantId === undefined ? "1 = 1" : "merchant_id = ?"}
     ORDER BY merchant_id, list_id, entry_id`,
    )
    .all<ListEntrySourceRow>(...ownerBindings);
  for (const entry of entries)
    materializeListEntryAttributes(database, collect, entry);
  // Two assignments with one key keep the later one, as the earlier upsert did.
  syncDerivedRelationRows(
    database,
    {
      table: "commerce_entity_attribute_relation_index",
      columns: ATTRIBUTE_RELATION_COLUMNS,
      keyColumns: ATTRIBUTE_RELATION_KEY_COLUMNS,
      ownerPredicate,
      ownerBindings,
    },
    desired,
  );
}

export function readCommerceAttributeOrderingValue(
  database: CommerceDatabase,
  subject: CommerceAttributeRelationSubject,
  attributeId: string,
): CommerceOrderingValue {
  const row = database
    .prepare(
      `SELECT value_kind AS valueKind,
            comparable_text AS comparableText,
            comparable_integer AS comparableInteger,
            comparable_real AS comparableReal,
            comparable_boolean AS comparableBoolean
       FROM commerce_entity_attribute_relation
      WHERE merchant_id = ? AND subject_kind = ? AND entity_origin = ?
        AND entity_type = ? AND entity_id = ? AND list_id = ? AND entry_id = ?
        AND attribute_id = ?`,
    )
    .get<AttributeOrderingRow>(
      subject.merchantId,
      subject.subjectKind,
      subject.entityOrigin,
      subject.entityType,
      subject.entityId,
      subject.listId,
      subject.entryId,
      attributeId,
    );
  if (row === undefined) return { kind: "null" };
  switch (row.valueKind) {
    case "short_text":
    case "long_text":
    case "status":
    case "date":
    case "timestamp":
      return row.comparableText === null
        ? { kind: "null" }
        : { kind: "text", value: row.comparableText };
    case "integer":
      return row.comparableInteger === null
        ? { kind: "null" }
        : { kind: "integer", value: BigInt(row.comparableInteger) };
    case "decimal":
      return row.comparableText === null
        ? { kind: "null" }
        : parseDecimalOrderingValue(row.comparableText);
    case "boolean":
      return row.comparableBoolean === null
        ? { kind: "null" }
        : { kind: "boolean", value: row.comparableBoolean === 1 };
    default:
      return { kind: "null" };
  }
}

export function readCommerceCanonicalSystemAttributeAssignments(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
): readonly AttributeValueAssignment[] {
  const rows = database
    .prepare(
      `SELECT attribute_id AS attributeId, definition_revision AS definitionRevision,
            value_kind AS valueKind, comparable_text AS comparableText,
            comparable_integer AS comparableInteger, comparable_real AS comparableReal,
            comparable_boolean AS comparableBoolean
       FROM commerce_entity_attribute_relation
      WHERE merchant_id = ? AND subject_kind = 'entity'
        AND entity_origin = 'system' AND entity_type = ? AND entity_id = ?
        AND list_id = '' AND entry_id = ''
        AND attribute_id IN (
          'lifecycle', 'low_stock', 'order_id', 'expected_by',
          'fulfillment_id', 'tracking_number', 'failed_at', 'failure_reason',
          'captured_at', 'price', 'price_policy', 'price_policy_revision',
          'price_minimum', 'price_maximum'
        )
      ORDER BY attribute_id`,
    )
    .all<
      Readonly<{
        attributeId: string;
        definitionRevision: number;
        valueKind: string;
        comparableText: string | null;
        comparableInteger: number | null;
        comparableReal: number | null;
        comparableBoolean: number | null;
      }>
    >(merchantId, reference.typeId, reference.entityId);
  return rows.map((row) =>
    parseAttributeAssignment({
      attributeId: row.attributeId,
      scope: {
        kind: "system",
        entityTypeId: reference.typeId,
        schemaRevision: 1,
      },
      definitionRevision: row.definitionRevision,
      sensitivity: "internal",
      value: canonicalAttributeValue(row),
    }),
  );
}

export function canonicalSystemAttributeDefinitions(
  typeId: SystemKind,
): readonly AttributeDefinition[] {
  const lifecycleOptions = systemLifecycleOptions(typeId);
  const definitions: Array<unknown> =
    lifecycleOptions === undefined
      ? []
      : [
          {
            id: "lifecycle",
            scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
            label: "Lifecycle",
            helpText: null,
            required: false,
            sensitivity: "internal",
            kind: {
              kind: "status",
              options: lifecycleOptions.map((id) => ({ id, label: id })),
            },
            revision: 1,
          },
        ];
  if (typeId === "stock_policy") {
    definitions.push({
      id: "low_stock",
      scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
      label: "Low stock",
      helpText: null,
      required: false,
      sensitivity: "internal",
      kind: { kind: "boolean" },
      revision: 1,
    });
  }
  if (typeId === "payment") {
    definitions.push(
      canonicalTextDefinition(typeId, "order_id", "Order ID", "short_text"),
      canonicalTextDefinition(typeId, "failed_at", "Failed at", "timestamp"),
      canonicalTextDefinition(
        typeId,
        "failure_reason",
        "Failure reason",
        "short_text",
      ),
      canonicalTextDefinition(
        typeId,
        "captured_at",
        "Captured at",
        "timestamp",
      ),
    );
  }
  if (typeId === "offer") {
    definitions.push(
      canonicalMoneyDefinition(typeId, "price", "Price"),
      {
        id: "price_policy",
        scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
        label: "Price policy",
        helpText: null,
        required: false,
        sensitivity: "internal",
        kind: {
          kind: "status",
          options: OFFER_PRICE_POLICY_STATES.map((id) => ({ id, label: id })),
        },
        revision: 1,
      },
      {
        id: "price_policy_revision",
        scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
        label: "Price policy revision",
        helpText: null,
        required: false,
        sensitivity: "internal",
        kind: { kind: "integer", minimum: 1, maximum: null },
        revision: 1,
      },
      canonicalMoneyDefinition(typeId, "price_minimum", "Lowest allowed price"),
      canonicalMoneyDefinition(
        typeId,
        "price_maximum",
        "Highest allowed price",
      ),
    );
  }
  if (typeId === "fulfillment") {
    definitions.push(
      canonicalTextDefinition(typeId, "order_id", "Order ID", "short_text"),
    );
    definitions.push(
      canonicalTextDefinition(
        typeId,
        "expected_by",
        "Expected by",
        "timestamp",
      ),
    );
  }
  if (typeId === "shipment") {
    definitions.push(
      canonicalTextDefinition(typeId, "order_id", "Order ID", "short_text"),
    );
    definitions.push(
      canonicalTextDefinition(
        typeId,
        "fulfillment_id",
        "Fulfillment ID",
        "short_text",
      ),
    );
    definitions.push(
      canonicalTextDefinition(
        typeId,
        "tracking_number",
        "Tracking number",
        "short_text",
      ),
    );
  }
  return definitions.map(parseAttributeDefinition);
}

function canonicalTextDefinition(
  typeId: SystemKind,
  id: string,
  label: string,
  kind: "short_text" | "timestamp",
): unknown {
  return {
    id,
    scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
    label,
    helpText: null,
    required: false,
    sensitivity: "internal",
    kind: kind === "short_text" ? { kind, maxLength: 256 } : { kind },
    revision: 1,
  };
}

function canonicalMoneyDefinition(
  typeId: SystemKind,
  id: string,
  label: string,
): unknown {
  return {
    id,
    scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
    label,
    helpText: null,
    required: false,
    sensitivity: "internal",
    kind: { kind: "money", allowedCurrencies: OFFER_PRICE_CURRENCIES },
    revision: 1,
  };
}

function systemLifecycleOptions(
  typeId: SystemKind,
): readonly string[] | undefined {
  switch (typeId) {
    case "location":
    case "sales_channel":
    case "inventory_item":
    case "preparation_station":
    case "stock_policy":
      return ["active", "inactive"];
    case "inventory_lot":
      return ["available", "depleted", "quarantined", "expired"];
    case "offer":
      return ["prepared", "listed", "archived"];
    case "order":
      return [
        "pending_confirmation",
        "confirmed",
        "fulfillment_pending",
        "partially_fulfilled",
        "fulfilled",
        "cancelled",
      ];
    case "payment":
      return [
        "pending",
        "authorized",
        "captured",
        "failed",
        "partially_refunded",
        "refunded",
      ];
    case "fulfillment":
      return [
        "requested",
        "preparing",
        "blocked",
        "handed_to_carrier",
        "ready_for_pickup",
        "completed",
        "cancelled",
      ];
    case "shipment":
      return [
        "ready",
        "label_purchased",
        "label_created",
        "in_transit",
        "delivery_exception",
        "delivered",
        "returned",
      ];
    case "menu":
      return ["draft", "published", "archived"];
    case "modifier_group_revision":
    case "recipe_revision":
      return ["draft", "active", "retired"];
    case "preparation_ticket":
      return ["queued", "preparing", "blocked", "completed", "cancelled"];
    case "product":
    case "sellable_variant":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_consumption_plan":
    case "inventory_consumption_requirement":
    case "production_batch":
      return undefined;
    default:
      return assertNever(typeId, "commerce_attribute_relation_unhandled");
  }
}

function canonicalAttributeValue(
  row: Readonly<{
    valueKind: string;
    comparableText: string | null;
    comparableInteger: number | null;
    comparableReal: number | null;
    comparableBoolean: number | null;
  }>,
): unknown {
  switch (row.valueKind) {
    case "status":
      if (row.comparableText !== null)
        return { kind: "status", value: row.comparableText };
      break;
    case "boolean":
      if (row.comparableBoolean !== null)
        return { kind: "boolean", value: row.comparableBoolean === 1 };
      break;
    case "short_text":
    case "long_text":
    case "date":
    case "timestamp":
      if (row.comparableText !== null)
        return { kind: row.valueKind, value: row.comparableText };
      break;
    case "integer":
      if (row.comparableInteger !== null)
        return { kind: "integer", value: row.comparableInteger };
      break;
    case "decimal":
      if (row.comparableText !== null)
        return parseDecimalAttributeValue(row.comparableText);
      break;
    case "money":
      if (row.comparableInteger !== null && row.comparableText !== null)
        return {
          kind: "money",
          value: {
            amountMinor: row.comparableInteger,
            currency: row.comparableText,
          },
        };
      break;
    default:
      break;
  }
  throw new Error(
    "commerce_entity_attribute_relation canonical scalar is invalid",
  );
}

function parseDecimalAttributeValue(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  }
  if (!isRecord(parsed))
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  const unscaled = parsed.unscaled;
  const scale = parsed.scale;
  if (
    typeof unscaled !== "number" ||
    !Number.isSafeInteger(unscaled) ||
    typeof scale !== "number" ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 6
  ) {
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  }
  return { kind: "decimal", value: { unscaled, scale } };
}

function parseDecimalOrderingValue(value: string): CommerceOrderingValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  }
  if (!isRecord(parsed))
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  const unscaled = parsed.unscaled;
  const scale = parsed.scale;
  if (
    typeof unscaled !== "number" ||
    !Number.isSafeInteger(unscaled) ||
    typeof scale !== "number" ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 6
  ) {
    throw new Error(
      "commerce_entity_attribute_relation decimal scalar is invalid",
    );
  }
  return { kind: "decimal", value: { unscaled, scale } };
}

function materializeListEntryAttributes(
  database: CommerceDatabase,
  collect: (assignment: AttributeInsert) => void,
  entry: ListEntrySourceRow,
): void {
  const rows = database
    .prepare(
      `SELECT entry_id AS entryId, entry_revision AS entryRevision,
            attribute_id AS attributeId, definition_revision AS definitionRevision,
            value_kind AS valueKind,
            short_text_value AS shortTextValue, long_text_value AS longTextValue,
            integer_value AS integerValue, decimal_value AS decimalValue,
            boolean_value AS booleanValue, date_value AS dateValue,
            timestamp_value AS timestampValue, status_value AS statusValue,
            choice_value AS choiceValue, money_amount_minor AS moneyAmountMinor,
            money_currency AS moneyCurrency,
            merchant_operator_reference_value AS merchantOperatorReferenceValue,
            external_resource_reference_value AS externalResourceReferenceValue
     FROM commerce_list_entry_attribute_value
     WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ?
     ORDER BY attribute_id`,
    )
    .all<ListEntryAttributeRow>(
      entry.merchantId,
      entry.entryId,
      entry.entryRevision,
    );
  for (const row of rows) {
    collect({
      merchantId: entry.merchantId,
      subjectKind: "list_entry",
      entityOrigin: entry.entityOrigin,
      entityType: entry.entityType,
      entityId: entry.entityId,
      listId: entry.listId,
      entryId: entry.entryId,
      entityRevision: entry.entryRevision,
      attributeId: row.attributeId,
      definitionRevision: row.definitionRevision,
      value: parseAttributeValue(storedValue(row)),
    });
  }
}

function readEntityAttributeRows(
  database: CommerceDatabase,
  entity: EntityRelationSourceRow,
  reference: CommerceEntityRef,
): readonly EntityAttributeRow[] {
  if (reference.origin === "system") {
    const extensionRows = database
      .prepare(
        `SELECT value.attribute_id AS attributeId,
              value.extension_schema_revision AS definitionRevision,
              value.value_kind AS valueKind,
              value.short_text_value AS shortTextValue, value.long_text_value AS longTextValue,
              value.integer_value AS integerValue, value.decimal_value AS decimalValue,
              value.boolean_value AS booleanValue, value.date_value AS dateValue,
              value.timestamp_value AS timestampValue, value.status_value AS statusValue,
              value.choice_value AS choiceValue, value.money_amount_minor AS moneyAmountMinor,
              value.money_currency AS moneyCurrency,
              value.merchant_operator_reference_value AS merchantOperatorReferenceValue,
              value.external_resource_reference_value AS externalResourceReferenceValue
         FROM system_entity_extension_value AS value
         JOIN system_entity_extension_schema_head AS head
           ON head.merchant_id = value.merchant_id
          AND head.system_entity_type_id = value.system_entity_type_id
          AND head.published_revision = value.extension_schema_revision
         WHERE value.merchant_id = ? AND value.system_entity_type_id = ?
           AND value.system_entity_id = ? AND head.lifecycle_state = 'published'
         ORDER BY value.attribute_id`,
      )
      .all<EntityAttributeRow>(
        entity.merchantId,
        entity.entityType,
        entity.entityId,
      );
    return [
      ...canonicalSystemAttributeRows(database, entity, reference),
      ...extensionRows,
    ];
  }
  return database
    .prepare(
      `SELECT value.attribute_id AS attributeId,
            custom.entity_type_revision AS definitionRevision,
            value.value_kind AS valueKind,
            value.short_text_value AS shortTextValue, value.long_text_value AS longTextValue,
            value.integer_value AS integerValue, value.decimal_value AS decimalValue,
            value.boolean_value AS booleanValue, value.date_value AS dateValue,
            value.timestamp_value AS timestampValue, value.status_value AS statusValue,
            value.choice_value AS choiceValue, value.money_amount_minor AS moneyAmountMinor,
            value.money_currency AS moneyCurrency,
            value.merchant_operator_reference_value AS merchantOperatorReferenceValue,
            value.external_resource_reference_value AS externalResourceReferenceValue
       FROM custom_entity_attribute_value AS value
       JOIN custom_entity AS custom
         ON custom.merchant_id = value.merchant_id AND custom.entity_id = value.entity_id
        AND custom.revision = value.entity_revision
       WHERE value.merchant_id = ? AND value.entity_id = ? AND value.entity_revision = ?
       ORDER BY value.attribute_id`,
    )
    .all<EntityAttributeRow>(
      entity.merchantId,
      entity.entityId,
      entity.revision,
    );
}

function canonicalSystemAttributeRows(
  database: CommerceDatabase,
  entity: EntityRelationSourceRow,
  reference: SystemCommerceEntityRef,
): readonly EntityAttributeRow[] {
  const lifecycle = readCanonicalLifecycle(
    database,
    entity.merchantId,
    reference,
  );
  const rows: EntityAttributeRow[] =
    lifecycle === null ? [] : [statusAttributeRow(lifecycle)];
  if (reference.typeId === "payment") {
    rows.push(
      ...readPaymentAttributeRows(
        database,
        entity.merchantId,
        reference.entityId,
      ),
    );
  }
  if (reference.typeId === "offer") {
    rows.push(
      ...readOfferPriceAttributeRows(
        database,
        entity.merchantId,
        reference.entityId,
      ),
    );
  }
  if (reference.typeId === "stock_policy") {
    const lowStock = readStockPolicyLowStock(
      database,
      entity.merchantId,
      reference.entityId,
    );
    if (lowStock !== null)
      rows.push(booleanAttributeRow("low_stock", lowStock));
  }
  if (reference.typeId === "fulfillment") {
    const attributes = readFulfillmentAttributes(
      database,
      entity.merchantId,
      reference.entityId,
    );
    if (attributes !== null) {
      rows.push(textAttributeRow("order_id", attributes.orderId));
      if (attributes.expectedBy !== null) {
        rows.push(timestampAttributeRow("expected_by", attributes.expectedBy));
      }
    }
  }
  if (reference.typeId === "shipment") {
    const attributes = readShipmentAttributes(
      database,
      entity.merchantId,
      reference.entityId,
    );
    if (attributes !== null) {
      rows.push(textAttributeRow("order_id", attributes.orderId));
      rows.push(textAttributeRow("fulfillment_id", attributes.fulfillmentId));
      if (attributes.trackingNumber !== null) {
        rows.push(
          textAttributeRow("tracking_number", attributes.trackingNumber),
        );
      }
    }
  }
  return rows;
}

function readPaymentAttributeRows(
  database: CommerceDatabase,
  merchantId: string,
  paymentId: string,
): readonly EntityAttributeRow[] {
  const row = database
    .prepare(
      `SELECT payment_snapshot_json AS snapshotJson FROM payment
     WHERE merchant_id = ? AND resource_id = ?`,
    )
    .get<Readonly<{ snapshotJson: string }>>(merchantId, paymentId);
  if (row === undefined) return [];
  const payment = parsePayment(parseJson(row.snapshotJson));
  const rows = [textAttributeRow("order_id", payment.orderId)];
  switch (payment.lifecycle.state) {
    case "failed":
      rows.push(
        timestampAttributeRow("failed_at", payment.lifecycle.failedAt),
        textAttributeRow("failure_reason", payment.lifecycle.reason),
      );
      break;
    case "captured":
      rows.push(
        timestampAttributeRow("captured_at", payment.lifecycle.capturedAt),
      );
      break;
    case "pending":
    case "authorized":
    case "partially_refunded":
    case "refunded":
      break;
    default:
      assertNever(payment.lifecycle);
  }
  return rows;
}

/**
 * The Offer's price beside the policy that bounds an agent's price change.
 *
 * A price proposal names the policy revision it was built against, so the
 * revision and the allowed range are read with the price they apply to. An
 * Offer with no policy row carries only its price: no revision exists that a
 * proposal could bind to.
 */
function readOfferPriceAttributeRows(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): readonly EntityAttributeRow[] {
  const row = database
    .prepare(
      `SELECT offer.amount_minor AS amountMinor, offer.currency AS currency,
            policy.revision AS policyRevision, policy.lifecycle AS policyState,
            policy.reference_price_minor AS referencePriceMinor,
            policy.max_movement_bps AS maxMovementBps
       FROM offer
       LEFT JOIN offer_price_policy AS policy
         ON policy.merchant_id = offer.merchant_id
        AND policy.offer_id = offer.resource_id
      WHERE offer.merchant_id = ? AND offer.resource_id = ?`,
    )
    .get<
      Readonly<{
        amountMinor: number;
        currency: string;
        policyRevision: number | null;
        policyState: "enabled" | "disabled" | null;
        referencePriceMinor: number | null;
        maxMovementBps: number | null;
      }>
    >(merchantId, offerId);
  // A money attribute names its currencies; an Offer in any other currency
  // shows no price fields rather than failing the whole read.
  if (row === undefined || !OFFER_PRICE_CURRENCIES.includes(row.currency))
    return [];
  const rows = [moneyAttributeRow("price", row.amountMinor, row.currency)];
  if (row.policyRevision === null || row.policyState === null) return rows;
  rows.push(
    statusAttributeRow(row.policyState, "price_policy"),
    integerAttributeRow("price_policy_revision", row.policyRevision),
  );
  if (
    row.policyState === "enabled" &&
    row.referencePriceMinor !== null &&
    row.maxMovementBps !== null
  ) {
    const range = allowedPriceRange({
      referencePriceMinor: row.referencePriceMinor,
      maxMovementBps: row.maxMovementBps,
    });
    rows.push(
      moneyAttributeRow("price_minimum", range.minimumMinor, row.currency),
      moneyAttributeRow("price_maximum", range.maximumMinor, row.currency),
    );
  }
  return rows;
}

function readFulfillmentAttributes(
  database: CommerceDatabase,
  merchantId: string,
  fulfillmentId: string,
): Readonly<{ orderId: string; expectedBy: string | null }> | null {
  const row = database
    .prepare(
      `SELECT order_id AS orderId,
            json_extract(fulfillment_snapshot_json, '$.expectedBy') AS expectedBy
       FROM fulfillment
      WHERE merchant_id = ? AND resource_id = ?`,
    )
    .get<Readonly<{ orderId: string; expectedBy: string | null }>>(
      merchantId,
      fulfillmentId,
    );
  if (row === undefined) return null;
  return row;
}

function readShipmentAttributes(
  database: CommerceDatabase,
  merchantId: string,
  shipmentId: string,
): Readonly<{
  orderId: string;
  fulfillmentId: string;
  trackingNumber: string | null;
}> | null {
  const row = database
    .prepare(
      `SELECT order_id AS orderId, fulfillment_id AS fulfillmentId,
            CASE
              WHEN json_extract(shipment_snapshot_json, '$.kind') = 'external'
                THEN json_extract(shipment_snapshot_json, '$.trackingNumber')
              WHEN lifecycle_state IN ('label_purchased', 'in_transit', 'delivered')
                THEN json_extract(shipment_snapshot_json, '$.lifecycle.trackingNumber')
              ELSE NULL
            END AS trackingNumber
       FROM shipment
      WHERE merchant_id = ? AND resource_id = ?`,
    )
    .get<
      Readonly<{
        orderId: string;
        fulfillmentId: string;
        trackingNumber: string | null;
      }>
    >(merchantId, shipmentId);
  return row ?? null;
}

function readCanonicalLifecycle(
  database: CommerceDatabase,
  merchantId: string,
  reference: SystemCommerceEntityRef,
): string | null {
  const source = lifecycleSource(reference.typeId);
  if (source === null) return null;
  const row = database
    .prepare(
      `SELECT ${source.lifecycleColumn} AS lifecycleState
       FROM ${source.table}
      WHERE merchant_id = ? AND ${source.idColumn} = ?${source.resourceKind === null ? "" : ` AND resource_kind = ? AND ${foodServiceLatestRevision(source.table)}`}`,
    )
    .get<LifecycleRow>(
      ...(source.resourceKind === null
        ? [merchantId, reference.entityId]
        : [merchantId, reference.entityId, source.resourceKind]),
    );
  return row?.lifecycleState ?? null;
}

type LifecycleSource = Readonly<{
  table: string;
  idColumn: string;
  lifecycleColumn: "lifecycle" | "lifecycle_state";
  resourceKind: string | null;
}>;

function lifecycleSource(
  typeId: SystemCommerceEntityRef["typeId"],
): LifecycleSource | null {
  switch (typeId) {
    case "inventory_item":
      return {
        table: "inventory_item",
        idColumn: "inventory_item_id",
        lifecycleColumn: "lifecycle",
        resourceKind: null,
      };
    case "inventory_lot":
      return {
        table: "stock_lot",
        idColumn: "lot_id",
        lifecycleColumn: "lifecycle",
        resourceKind: null,
      };
    case "location":
      return {
        table: "location",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "sales_channel":
      return {
        table: "sales_channel",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "offer":
      return {
        table: "offer",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "order":
      return {
        table: "commerce_order",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "payment":
      return {
        table: "payment",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "fulfillment":
      return {
        table: "fulfillment",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "shipment":
      return {
        table: "shipment",
        idColumn: "resource_id",
        lifecycleColumn: "lifecycle_state",
        resourceKind: null,
      };
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "stock_policy":
      return {
        table: FOOD_SERVICE_ENTITY_ROWS.table,
        idColumn: FOOD_SERVICE_ENTITY_ROWS.idColumn,
        lifecycleColumn: FOOD_SERVICE_ENTITY_ROWS.lifecycleColumn,
        resourceKind: typeId,
      };
    case "product":
    case "sellable_variant":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_consumption_plan":
    case "inventory_consumption_requirement":
    case "production_batch":
      return null;
    default:
      return assertNever(typeId, "commerce_attribute_relation_unhandled");
  }
}

function statusAttributeRow(
  value: string,
  attributeId = "lifecycle",
): EntityAttributeRow {
  return {
    attributeId,
    definitionRevision: 1,
    valueKind: "status",
    shortTextValue: null,
    longTextValue: null,
    integerValue: null,
    decimalValue: null,
    booleanValue: null,
    dateValue: null,
    timestampValue: null,
    statusValue: value,
    choiceValue: null,
    moneyAmountMinor: null,
    moneyCurrency: null,
    merchantOperatorReferenceValue: null,
    externalResourceReferenceValue: null,
  };
}

function booleanAttributeRow(
  attributeId: string,
  value: boolean,
): EntityAttributeRow {
  return {
    attributeId,
    definitionRevision: 1,
    valueKind: "boolean",
    shortTextValue: null,
    longTextValue: null,
    integerValue: null,
    decimalValue: null,
    booleanValue: value ? 1 : 0,
    dateValue: null,
    timestampValue: null,
    statusValue: null,
    choiceValue: null,
    moneyAmountMinor: null,
    moneyCurrency: null,
    merchantOperatorReferenceValue: null,
    externalResourceReferenceValue: null,
  };
}

function integerAttributeRow(
  attributeId: string,
  value: number,
): EntityAttributeRow {
  return {
    ...scalarTextAttributeRow(attributeId, "short_text", ""),
    valueKind: "integer",
    shortTextValue: null,
    integerValue: value,
  };
}

function moneyAttributeRow(
  attributeId: string,
  amountMinor: number,
  currency: string,
): EntityAttributeRow {
  return {
    ...scalarTextAttributeRow(attributeId, "short_text", ""),
    valueKind: "money",
    shortTextValue: null,
    moneyAmountMinor: amountMinor,
    moneyCurrency: currency,
  };
}

function textAttributeRow(
  attributeId: string,
  value: string,
): EntityAttributeRow {
  return scalarTextAttributeRow(attributeId, "short_text", value);
}

function timestampAttributeRow(
  attributeId: string,
  value: string,
): EntityAttributeRow {
  return scalarTextAttributeRow(attributeId, "timestamp", value);
}

function scalarTextAttributeRow(
  attributeId: string,
  valueKind: "short_text" | "timestamp",
  value: string,
): EntityAttributeRow {
  return {
    attributeId,
    definitionRevision: 1,
    valueKind,
    shortTextValue: valueKind === "short_text" ? value : null,
    longTextValue: null,
    integerValue: null,
    decimalValue: null,
    booleanValue: null,
    dateValue: null,
    timestampValue: valueKind === "timestamp" ? value : null,
    statusValue: null,
    choiceValue: null,
    moneyAmountMinor: null,
    moneyCurrency: null,
    merchantOperatorReferenceValue: null,
    externalResourceReferenceValue: null,
  };
}

function readStockPolicyLowStock(
  database: CommerceDatabase,
  merchantId: string,
  stockPolicyId: string,
): boolean | null {
  const resourceJson = readLatestFoodServiceResourceJson(
    database,
    merchantId,
    "stock_policy",
    stockPolicyId,
  );
  if (resourceJson === undefined) return null;
  const observation = parseFoodServiceObservation({
    kind: "stock_policy",
    resource: JSON.parse(resourceJson) as unknown,
  });
  if (observation.kind !== "stock_policy") return null;
  const replenishment = observation.resource.replenishment;
  if (replenishment.kind !== "threshold") return false;
  const position = database
    .prepare(
      `SELECT available_amount AS availableAmount,
            quantity_scale AS quantityScale, quantity_unit AS quantityUnit
       FROM inventory_position
      WHERE merchant_id = ? AND inventory_item_id = ? AND location_id = ?`,
    )
    .get<InventoryPositionBalanceRow>(
      merchantId,
      observation.resource.inventoryItemId,
      observation.resource.locationId,
    );
  if (
    position === undefined ||
    position.quantityUnit !== replenishment.reorderPoint.unit
  )
    return false;
  const available =
    BigInt(position.availableAmount) *
    10n ** BigInt(replenishment.reorderPoint.scale);
  const reorderPoint =
    BigInt(replenishment.reorderPoint.amount) *
    10n ** BigInt(position.quantityScale);
  return available < reorderPoint;
}

type AttributeInsert = Readonly<{
  merchantId: string;
  subjectKind: "entity" | "list_entry";
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
  listId: string;
  entryId: string;
  entityRevision: number;
  attributeId: string;
  definitionRevision: number;
  value: AttributeValue;
}>;

/** One row of `commerce_entity_attribute_relation_index`, in column order. */
function attributeRelationRow(
  assignment: AttributeInsert,
): readonly CommerceSqlValue[] {
  const scalar = comparableScalars(assignment.value);
  return [
    assignment.merchantId,
    assignment.subjectKind,
    assignment.entityOrigin,
    assignment.entityType,
    assignment.entityId,
    assignment.listId,
    assignment.entryId,
    assignment.entityRevision,
    assignment.attributeId,
    assignment.definitionRevision,
    assignment.value.kind,
    scalar.text,
    scalar.integer,
    scalar.real,
    scalar.boolean,
  ];
}

type ComparableScalars = Readonly<{
  text: string | null;
  integer: number | null;
  real: number | null;
  boolean: number | null;
}>;

function comparableScalars(value: AttributeValue): ComparableScalars {
  switch (value.kind) {
    case "short_text":
    case "long_text":
    case "date":
    case "timestamp":
    case "status":
      return { text: value.value, integer: null, real: null, boolean: null };
    case "integer":
      return {
        text: null,
        integer: Number(value.value),
        real: null,
        boolean: null,
      };
    case "decimal":
      return {
        text: JSON.stringify(value.value),
        integer: null,
        real: Number(value.value.unscaled) / 10 ** value.value.scale,
        boolean: null,
      };
    case "boolean":
      return {
        text: null,
        integer: null,
        real: null,
        boolean: value.value ? 1 : 0,
      };
    // Filters and ordering do not compare money; the pair only lets a
    // canonical money value be read back from the relation.
    case "money":
      return {
        text: value.value.currency,
        integer: value.value.amountMinor,
        real: null,
        boolean: null,
      };
    default:
      return { text: null, integer: null, real: null, boolean: null };
  }
}

function createAttributeRelationViewSql(): string {
  return `CREATE VIEW commerce_entity_attribute_relation (
  merchant_id, subject_kind, entity_origin, entity_type, entity_id,
  list_id, entry_id, entity_revision, attribute_id, definition_revision,
  value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
) AS
SELECT merchant_id, subject_kind, entity_origin, entity_type, entity_id,
       list_id, entry_id, entity_revision, attribute_id, definition_revision,
       value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
FROM commerce_entity_attribute_relation_index;`;
}

function assertAttributeRelation(
  database: CommerceDatabase,
  expectedViewSql: string,
): void {
  const view = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'commerce_entity_attribute_relation'`,
    )
    .get<Readonly<{ sql: string | null }>>();
  if (
    view === undefined ||
    view.sql === null ||
    normalizeSql(view.sql) !== expectedViewSql
  ) {
    throw new Error(
      "commerce_entity_attribute_relation view definition drifted",
    );
  }
  assertExactRelationColumns(
    database,
    "commerce_entity_attribute_relation",
    ATTRIBUTE_RELATION_COLUMNS,
  );
  assertExactRelationColumns(
    database,
    "commerce_entity_attribute_relation_index",
    ATTRIBUTE_RELATION_COLUMNS,
  );
  for (const index of [
    "commerce_entity_attribute_relation_filter_idx",
    "commerce_entity_attribute_relation_order_idx",
  ]) {
    if (
      !relationTableHasIndex(
        database,
        "commerce_entity_attribute_relation_index",
        index,
      )
    ) {
      throw new Error(
        `commerce_entity_attribute_relation index is missing: ${index}`,
      );
    }
  }
  if (
    !explainUsesIndex(
      database,
      `SELECT attribute_id FROM commerce_entity_attribute_relation
     WHERE merchant_id = ? AND subject_kind = 'entity'
       AND entity_origin = ? AND entity_type = ? AND entity_id = ?
       AND list_id = '' AND entry_id = '' AND attribute_id = ?`,
      ["merchant_explain", "system", "order", "order_explain", "lifecycle"],
      "commerce_entity_attribute_relation_filter_idx",
    )
  ) {
    throw new Error(
      "commerce_entity_attribute_relation EXPLAIN does not use its filter index",
    );
  }
}
