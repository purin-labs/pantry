import type {
  CommerceCursorBoundary,
  CommerceEntityRef,
  CommerceEffectiveOrdering,
  CommerceOrderingValue,
  CommerceQueryPlan,
  CommerceQueryPlanErrorCapability,
} from "@seams/commerce-contracts";
import {
  compileCommerceQuerySql,
  type CommerceSqliteBinding,
} from "@seams/commerce-query-sqlite";

import type { CommerceDatabase, CommerceSqlValue } from "../database.ts";
import { parseEntityRef, parsePositiveRevision } from "./parsers.ts";
import { readCommerceAttributeOrderingValue } from "./commerce-attribute-relation.ts";
import {
  assertExactRelationColumns,
  normalizeRelationSql as normalizeSql,
  relationTableHasIndex,
} from "./relation-schema.ts";
import type { Variant } from "@seams/type-utils";
import { assertNever, isNormalizedText } from "@seams/std";

const COMMERCE_ENTITY_RELATION_SCHEMA_VERSION = 7;
const COMMERCE_LIST_ENTRY_RELATION_SCHEMA_VERSION = 1;

type RelationSchemaRow = Readonly<{ version: number; viewSql: string | null }>;
type RelationViewRow = Readonly<{
  merchant_id: unknown;
  entity_origin: unknown;
  entity_type: unknown;
  entity_id: unknown;
  revision: unknown;
  updated_at: unknown;
  display_name: unknown;
  display_name_folded: unknown;
  search_text_folded: unknown;
  payload_json: unknown;
}>;
type ListEntryRelationViewRow = Readonly<{
  merchant_id: unknown;
  list_id: unknown;
  entry_id: unknown;
  entry_revision: unknown;
  entity_origin: unknown;
  entity_type: unknown;
  entity_id: unknown;
  updated_at: unknown;
}>;

export type CommerceEntityRelationRow = Readonly<{
  merchantId: string;
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
  revision: number;
  updatedAt: number;
  displayName: string;
  displayNameFolded: string;
  searchTextFolded: string;
  payloadJson: string | null;
  reference: CommerceEntityRef;
}>;

export type CommerceEntityRelationReadResult =
  | Readonly<{
      kind: "count";
      value: number;
    }>
  | Readonly<{
      kind: "rows";
      rows: readonly CommerceEntityRelationRow[];
      execution: CommerceEntityRelationExecution;
    }>
  | Readonly<{
      kind: "list_rows";
      rows: readonly CommerceListEntryRelationRow[];
      execution: Variant<CommerceEntityRelationExecution, "page">;
    }>
  | Readonly<{
      kind: "unsupported";
      capability: CommerceQueryPlanErrorCapability;
    }>;

export type CommerceEntityRelationExecution =
  | Readonly<{
      kind: "exact";
      requestedLimit: 1;
      fetchedRowCount: number;
      retainedRowCount: number;
      hasMore: false;
      nextBoundary: null;
    }>
  | Readonly<{
      kind: "page";
      requestedLimit: number;
      fetchedRowCount: number;
      retainedRowCount: number;
      hasMore: boolean;
      effectiveOrdering: CommerceEffectiveOrdering;
      nextBoundary: CommerceCursorBoundary | null;
    }>;

export type CommerceListEntryRelationRow = Readonly<{
  merchantId: string;
  listId: string;
  entryId: string;
  entryRevision: number;
  entityOrigin: "system" | "custom";
  entityType: string;
  entityId: string;
  updatedAt: number;
  reference: CommerceEntityRef;
}>;

const RELATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_entity_relation_schema (
  relation_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  view_sql TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS commerce_entity_relation_index (
  merchant_id TEXT NOT NULL,
  entity_origin TEXT NOT NULL CHECK (entity_origin IN ('system', 'custom')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  display_name TEXT NOT NULL,
  display_name_folded TEXT NOT NULL,
  search_text_folded TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  PRIMARY KEY (merchant_id, entity_origin, entity_type, entity_id)
) STRICT;

CREATE INDEX IF NOT EXISTS commerce_entity_relation_index_presentation_idx
  ON commerce_entity_relation_index (
    merchant_id, entity_origin, entity_type, updated_at DESC, entity_id
  );
CREATE INDEX IF NOT EXISTS commerce_entity_relation_index_display_idx
  ON commerce_entity_relation_index (
    merchant_id, entity_origin, entity_type, display_name_folded, entity_id
  );
CREATE INDEX IF NOT EXISTS commerce_entity_relation_index_search_idx
  ON commerce_entity_relation_index (
    merchant_id, entity_origin, entity_type, search_text_folded, entity_id
  );
`;

const RELATION_COLUMNS = [
  "merchant_id",
  "entity_origin",
  "entity_type",
  "entity_id",
  "revision",
  "updated_at",
  "display_name",
  "display_name_folded",
  "search_text_folded",
  "payload_json",
] as const;

export function initializeCommerceEntityRelation(
  database: CommerceDatabase,
): void {
  database.transaction(() => {
    database.exec(RELATION_SCHEMA);
    ensureRelationSchemaDefinitionColumn(database);
    const installed = database
      .prepare(
        `SELECT version, view_sql AS viewSql FROM commerce_entity_relation_schema
       WHERE relation_name = 'commerce_entity'`,
      )
      .get<RelationSchemaRow>();
    // Versions 4 and 7 share the materialized relation; normalize its persisted marker.
    if (
      installed !== undefined &&
      installed.version !== 4 &&
      installed.version !== COMMERCE_ENTITY_RELATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported commerce_entity relation schema version: ${installed.version}`,
      );
    }
    const view = database
      .prepare(
        `SELECT sql FROM sqlite_master
       WHERE type = 'view' AND name = 'commerce_entity'`,
      )
      .get<Readonly<{ sql: string | null }>>();
    const expectedViewSql = normalizeSql(createCommerceEntityViewSql());
    const viewNeedsInstall =
      view === undefined ||
      view.sql === null ||
      installed?.viewSql !== expectedViewSql ||
      normalizeSql(view.sql) !== expectedViewSql;
    if (viewNeedsInstall) {
      database.exec("DROP VIEW IF EXISTS commerce_entity");
      database.exec(createCommerceEntityViewSql());
    }
    if (installed === undefined) {
      const result = database
        .prepare(
          `INSERT INTO commerce_entity_relation_schema (relation_name, version, view_sql)
         VALUES ('commerce_entity', ?, ?)`,
        )
        .run(COMMERCE_ENTITY_RELATION_SCHEMA_VERSION, expectedViewSql);
      if (result.changes !== 1)
        throw new Error(
          "commerce_entity relation schema version was not recorded",
        );
    } else if (
      viewNeedsInstall ||
      installed.version !== COMMERCE_ENTITY_RELATION_SCHEMA_VERSION
    ) {
      const result = database
        .prepare(
          `UPDATE commerce_entity_relation_schema SET version = ?, view_sql = ?
         WHERE relation_name = 'commerce_entity'`,
        )
        .run(COMMERCE_ENTITY_RELATION_SCHEMA_VERSION, expectedViewSql);
      if (result.changes !== 1)
        throw new Error(
          "commerce_entity relation schema definition was not recorded",
        );
    }
    assertCommerceEntityRelation(database, expectedViewSql);
    installCommerceListEntryRelation(database);
  });
}

function installCommerceListEntryRelation(database: CommerceDatabase): void {
  const expectedViewSql = normalizeSql(createCommerceListEntryViewSql());
  const installed = database
    .prepare(
      `SELECT version, view_sql AS viewSql FROM commerce_entity_relation_schema
     WHERE relation_name = 'commerce_list_entry_relation'`,
    )
    .get<RelationSchemaRow>();
  if (
    installed !== undefined &&
    installed.version !== COMMERCE_LIST_ENTRY_RELATION_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported commerce_list_entry_relation schema version: ${installed.version}`,
    );
  }
  const view = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'commerce_list_entry_relation'`,
    )
    .get<Readonly<{ sql: string | null }>>();
  const viewNeedsInstall =
    view === undefined ||
    view.sql === null ||
    installed?.viewSql !== expectedViewSql ||
    normalizeSql(view.sql) !== expectedViewSql;
  if (viewNeedsInstall) {
    database.exec("DROP VIEW IF EXISTS commerce_list_entry_relation");
    database.exec(createCommerceListEntryViewSql());
  }
  if (installed === undefined) {
    database
      .prepare(
        `INSERT INTO commerce_entity_relation_schema (relation_name, version, view_sql) VALUES (?, ?, ?)`,
      )
      .run(
        "commerce_list_entry_relation",
        COMMERCE_LIST_ENTRY_RELATION_SCHEMA_VERSION,
        expectedViewSql,
      );
  } else if (viewNeedsInstall) {
    database
      .prepare(
        `UPDATE commerce_entity_relation_schema SET version = ?, view_sql = ? WHERE relation_name = ?`,
      )
      .run(
        COMMERCE_LIST_ENTRY_RELATION_SCHEMA_VERSION,
        expectedViewSql,
        "commerce_list_entry_relation",
      );
  }
  const expectedColumns = [
    "merchant_id",
    "list_id",
    "entry_id",
    "entry_revision",
    "entity_origin",
    "entity_type",
    "entity_id",
    "updated_at",
  ];
  assertExactRelationColumns(
    database,
    "commerce_list_entry_relation",
    expectedColumns,
  );
  if (
    !relationTableHasIndex(
      database,
      "commerce_list_entry",
      "commerce_list_entry_presentation_idx",
    )
  ) {
    throw new Error(
      "commerce_list_entry relation presentation index is missing",
    );
  }
}

export function readValidatedPlan(
  database: CommerceDatabase,
  ownerId: string,
  plan: CommerceQueryPlan,
): CommerceEntityRelationReadResult {
  const compiled = compileCommerceQuerySql({ ownerId, plan });
  if (compiled.kind === "unsupported") return compiled;
  const bindings = compiled.statement.bindings.map(toCommerceSqlValue);
  if (compiled.statement.execution.kind === "count") {
    const row = database
      .prepare(compiled.statement.sql)
      .get<Readonly<{ aggregate_count: unknown }>>(...bindings);
    return {
      kind: "count",
      value: safeCount(row?.aggregate_count, "commerce_entity.aggregate_count"),
    };
  }
  if (compiled.statement.execution.kind === "list_page") {
    const fetchedRows = database
      .prepare(compiled.statement.sql)
      .all<ListEntryRelationViewRow>(...bindings)
      .map(parseCommerceListEntryRelationRow);
    const retainedRows = fetchedRows.slice(
      0,
      compiled.statement.execution.requestedLimit,
    );
    const hasMore = fetchedRows.length > retainedRows.length;
    return {
      kind: "list_rows",
      rows: retainedRows,
      execution: {
        kind: "page",
        requestedLimit: compiled.statement.execution.requestedLimit,
        fetchedRowCount: fetchedRows.length,
        retainedRowCount: retainedRows.length,
        hasMore,
        effectiveOrdering: compiled.statement.execution.effectiveOrdering,
        nextBoundary: hasMore
          ? listEntryCursorBoundary(
              database,
              retainedRows.at(-1),
              compiled.statement.execution.effectiveOrdering,
            )
          : null,
      },
    };
  }
  const fetchedRows = database
    .prepare(compiled.statement.sql)
    .all<RelationViewRow>(...bindings)
    .map(parseCommerceEntityRelationRow);
  if (compiled.statement.execution.kind === "exact") {
    return {
      kind: "rows",
      rows: fetchedRows,
      execution: {
        kind: "exact",
        requestedLimit: 1,
        fetchedRowCount: fetchedRows.length,
        retainedRowCount: fetchedRows.length,
        hasMore: false,
        nextBoundary: null,
      },
    };
  }
  if (compiled.statement.execution.kind === "relationship_traversal_step") {
    return { kind: "unsupported", capability: { kind: "source_mapping" } };
  }
  const retainedRows = fetchedRows.slice(
    0,
    compiled.statement.execution.requestedLimit,
  );
  const hasMore = fetchedRows.length > retainedRows.length;
  return {
    kind: "rows",
    rows: retainedRows,
    execution: {
      kind: "page",
      requestedLimit: compiled.statement.execution.requestedLimit,
      fetchedRowCount: fetchedRows.length,
      retainedRowCount: retainedRows.length,
      hasMore,
      effectiveOrdering: compiled.statement.execution.effectiveOrdering,
      nextBoundary: hasMore
        ? relationCursorBoundary(
            database,
            retainedRows.at(-1),
            compiled.statement.execution.effectiveOrdering,
          )
        : null,
    },
  };
}

function listEntryCursorBoundary(
  database: CommerceDatabase,
  row: CommerceListEntryRelationRow | undefined,
  ordering: CommerceEffectiveOrdering,
): CommerceCursorBoundary | null {
  if (row === undefined) return null;
  return {
    entityRef: row.reference,
    orderingValues: ordering.leadingKeys.map((key) => {
      switch (key.field.kind) {
        case "updated_at":
          return { kind: "integer", value: BigInt(row.updatedAt) };
        case "attribute":
          return readCommerceAttributeOrderingValue(
            database,
            {
              merchantId: row.merchantId,
              subjectKind: "list_entry",
              entityOrigin: row.entityOrigin,
              entityType: row.entityType,
              entityId: row.entityId,
              listId: row.listId,
              entryId: row.entryId,
            },
            key.field.attributeId,
          );
        case "display_name":
          return listEntryDisplayNameOrderingValue(database, row);
        case "created_at":
          throw new Error(
            `commerce_list_entry relation ordering field is not materialized: ${key.field.kind}`,
          );
        default:
          return assertNever(key.field, "commerce_entity_relation_unhandled");
      }
    }),
  };
}

function listEntryDisplayNameOrderingValue(
  database: CommerceDatabase,
  row: CommerceListEntryRelationRow,
): CommerceOrderingValue {
  const entity = database
    .prepare(
      `SELECT display_name_folded FROM commerce_entity
        WHERE merchant_id = ? AND entity_origin = ? AND entity_type = ? AND entity_id = ?`,
    )
    .get<Readonly<{ display_name_folded: unknown }>>(
      row.merchantId,
      row.entityOrigin,
      row.entityType,
      row.entityId,
    );
  if (entity === undefined)
    throw new Error("Commerce List relation references a missing entity");
  return {
    kind: "text",
    value: normalizedText(
      entity.display_name_folded,
      "commerce_entity.display_name_folded",
    ),
  };
}

function relationCursorBoundary(
  database: CommerceDatabase,
  row: CommerceEntityRelationRow | undefined,
  ordering: CommerceEffectiveOrdering,
): CommerceCursorBoundary | null {
  if (row === undefined) return null;
  return {
    entityRef: row.reference,
    orderingValues: ordering.leadingKeys.map((key) =>
      relationOrderingValue(database, row, key.field),
    ),
  };
}

function relationOrderingValue(
  database: CommerceDatabase,
  row: CommerceEntityRelationRow,
  field: CommerceEffectiveOrdering["leadingKeys"][number]["field"],
): CommerceOrderingValue {
  switch (field.kind) {
    case "updated_at":
      return { kind: "integer", value: BigInt(row.updatedAt) };
    case "display_name":
      return { kind: "text", value: row.displayNameFolded };
    case "attribute":
      return readCommerceAttributeOrderingValue(
        database,
        {
          merchantId: row.merchantId,
          subjectKind: "entity",
          entityOrigin: row.entityOrigin,
          entityType: row.entityType,
          entityId: row.entityId,
          listId: "",
          entryId: "",
        },
        field.attributeId,
      );
    case "created_at":
      throw new Error(
        `commerce_entity relation ordering field is not materialized: ${field}`,
      );
    default:
      return assertNever(field, "commerce_entity_relation_unhandled");
  }
}

function parseCommerceEntityRelationRow(
  row: RelationViewRow,
): CommerceEntityRelationRow {
  const merchantId = normalizedText(
    row.merchant_id,
    "commerce_entity.merchant_id",
  );
  const entityOrigin = enumValue(
    row.entity_origin,
    "commerce_entity.entity_origin",
    ["system", "custom"] as const,
  );
  const entityType = normalizedText(
    row.entity_type,
    "commerce_entity.entity_type",
  );
  const entityId = normalizedText(row.entity_id, "commerce_entity.entity_id");
  const reference = parseEntityRef({
    origin: entityOrigin,
    typeId: entityType,
    entityId,
  });
  if (
    reference.origin !== entityOrigin ||
    reference.typeId !== entityType ||
    reference.entityId !== entityId
  ) {
    throw new Error("commerce_entity identity columns do not agree");
  }
  const payloadJson = nullableText(
    row.payload_json,
    "commerce_entity.payload_json",
  );
  if (payloadJson !== null)
    requireJson(payloadJson, "commerce_entity.payload_json");
  return {
    merchantId,
    entityOrigin,
    entityType,
    entityId,
    revision: parsePositiveRevision(row.revision, "commerce_entity.revision"),
    updatedAt: safeTimestampMillis(
      row.updated_at,
      "commerce_entity.updated_at",
    ),
    displayName: normalizedText(
      row.display_name,
      "commerce_entity.display_name",
    ),
    displayNameFolded: normalizedText(
      row.display_name_folded,
      "commerce_entity.display_name_folded",
    ),
    searchTextFolded: normalizedText(
      row.search_text_folded,
      "commerce_entity.search_text_folded",
    ),
    payloadJson,
    reference,
  };
}

function parseCommerceListEntryRelationRow(
  row: ListEntryRelationViewRow,
): CommerceListEntryRelationRow {
  const merchantId = normalizedText(
    row.merchant_id,
    "commerce_list_entry_relation.merchant_id",
  );
  const listId = normalizedText(
    row.list_id,
    "commerce_list_entry_relation.list_id",
  );
  const entryId = normalizedText(
    row.entry_id,
    "commerce_list_entry_relation.entry_id",
  );
  const entityOrigin = enumValue(
    row.entity_origin,
    "commerce_list_entry_relation.entity_origin",
    ["system", "custom"] as const,
  );
  const entityType = normalizedText(
    row.entity_type,
    "commerce_list_entry_relation.entity_type",
  );
  const entityId = normalizedText(
    row.entity_id,
    "commerce_list_entry_relation.entity_id",
  );
  return {
    merchantId,
    listId,
    entryId,
    entryRevision: parsePositiveRevision(
      row.entry_revision,
      "commerce_list_entry_relation.entry_revision",
    ),
    entityOrigin,
    entityType,
    entityId,
    updatedAt: safeTimestampMillis(
      row.updated_at,
      "commerce_list_entry_relation.updated_at",
    ),
    reference: parseEntityRef({
      origin: entityOrigin,
      typeId: entityType,
      entityId,
    }),
  };
}

function createCommerceEntityViewSql(): string {
  return `CREATE VIEW commerce_entity (
  merchant_id,
  entity_origin,
  entity_type,
  entity_id,
  revision,
  updated_at,
  display_name,
  display_name_folded,
  search_text_folded,
  payload_json
) AS
SELECT merchant_id, entity_origin, entity_type, entity_id, revision,
       updated_at, display_name, display_name_folded, search_text_folded, payload_json
FROM commerce_entity_relation_index;`;
}

function createCommerceListEntryViewSql(): string {
  return `CREATE VIEW commerce_list_entry_relation (
  merchant_id,
  list_id,
  entry_id,
  entry_revision,
  entity_origin,
  entity_type,
  entity_id,
  updated_at
) AS
SELECT merchant_id, list_id, entry_id, revision, entity_origin,
       entity_type_id, entity_id, updated_at_ms
FROM commerce_list_entry
WHERE lifecycle_state = 'active';`;
}

function ensureRelationSchemaDefinitionColumn(
  database: CommerceDatabase,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(commerce_entity_relation_schema)`)
    .all<Readonly<{ name: string }>>()
    .map((row) => row.name);
  if (!columns.includes("view_sql"))
    database.exec(
      "ALTER TABLE commerce_entity_relation_schema ADD COLUMN view_sql TEXT",
    );
}

function assertCommerceEntityRelation(
  database: CommerceDatabase,
  expectedViewSql: string,
): void {
  const view = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'commerce_entity'`,
    )
    .get<Readonly<{ sql: string | null }>>();
  if (
    view === undefined ||
    view.sql === null ||
    normalizeSql(view.sql) !== expectedViewSql
  ) {
    throw new Error("commerce_entity relation view definition drifted");
  }
  assertExactRelationColumns(database, "commerce_entity", RELATION_COLUMNS);
  assertExactRelationColumns(
    database,
    "commerce_entity_relation_index",
    RELATION_COLUMNS,
  );
  const indexes = [
    "commerce_entity_relation_index_presentation_idx",
    "commerce_entity_relation_index_display_idx",
    "commerce_entity_relation_index_search_idx",
  ];
  for (const index of indexes) {
    if (
      !relationTableHasIndex(database, "commerce_entity_relation_index", index)
    ) {
      throw new Error(`commerce_entity relation index is missing: ${index}`);
    }
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
    throw new Error("SQLite query binding exceeds the safe integer range");
  }
  return Number(value);
}

function normalizedText(value: unknown, field: string): string {
  if (!isNormalizedText(value)) {
    throw new Error(`${field} must be normalized text`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return normalizedText(value, field);
}

function enumValue<const T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const text = normalizedText(value, field);
  const match = allowed.find((entry) => entry === text);
  if (match === undefined) throw new Error(`${field} is unsupported`);
  return match;
}

function requireJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${field} must contain valid JSON`);
  }
}

function safeTimestampMillis(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative millisecond timestamp`);
  }
  return value;
}

function safeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}
