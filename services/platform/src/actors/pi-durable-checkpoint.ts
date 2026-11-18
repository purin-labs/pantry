import { canonicalJson, isRecord } from "@seams/std";
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { ActorExportTable, ActorImportSqlMigration } from "./actor-export";
import { createPiUsageSchema } from "./pi-durable-usage";
import type {
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessTurnResult,
} from "./embedded-harness";

// Only library-owned tables cross this persistence boundary. SQL identifiers
// come from this list and SQLite's schema, never from checkpoint input.
const TABLES = [
  "durable_schema",
  "durable_metadata",
  "record_ids",
  "conversations",
  "entries",
  "tasks",
  "submissions",
  "documents",
  "document_revisions",
  "satyr_pi_usage",
] as const;
type Cell = string | number | null;
type NativeTable = {
  name: (typeof TABLES)[number];
  columns: string[];
  rows: Cell[][];
};
export const PI_DURABLE_CHECKPOINT_FORMAT = "satyr-pi-durable-sqlite-v1";
/**
 * The Pi release and the revision of this adapter's stored contract. Revision
 * 2 keeps the values of scripts in Pi's own store document, and its Code Mode
 * receipts name their continuation. No build reads the checkpoint of another
 * build: a Session starts a fresh lineage from its accepted history.
 */
export const PI_DURABLE_BUILD = "pi-durable-1.5.0+actor.2";

/** Create library tables inside the existing empty-target import transaction. */
export const piDurableImportSchema: ActorImportSqlMigration = {
  prepare: preparePiDurableImport,
  complete: completePiDurableImport,
};

function preparePiDurableImport(
  sql: SqlStorage,
  tables: readonly ActorExportTable[],
): void {
  if (tables.some(isNativeSchemaTable)) {
    sql.exec(`CREATE TABLE durable_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT`);
    // Bootstrap rows come from the authenticated export, so the counters are
    // not duplicated. The other migration steps run on empty tables.
    for (const migration of SQLITE_MIGRATIONS) {
      for (const statement of migration.statements) {
        if (!statement.startsWith("INSERT INTO durable_metadata"))
          sql.exec(statement);
      }
    }
  }
  if (tables.some(isNativeUsageTable)) createPiUsageSchema(sql);
}
function isNativeSchemaTable(table: ActorExportTable): boolean {
  return table.name === "durable_schema";
}
function isNativeUsageTable(table: ActorExportTable): boolean {
  return table.name === "satyr_pi_usage";
}
function completePiDurableImport(): void {}

export function clearPiDurableTables(sql: SqlStorage): void {
  for (const table of [...TABLES].reverse())
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
}

export function preparePiDurableStorage(
  sql: SqlStorage,
  input: EmbeddedHarnessConstructionInput,
): void {
  if (input.source.kind === "resume_turn") return;
  clearPiDurableTables(sql);
  sql.exec(
    "CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0)) STRICT",
  );
  for (const migration of SQLITE_MIGRATIONS) {
    for (const statement of migration.statements) sql.exec(statement);
    sql.exec(
      "INSERT INTO durable_schema VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version",
      migration.version,
    );
  }
  createPiUsageSchema(sql);
  if (input.source.kind === "restore")
    restorePiDurableCheckpoint(
      sql,
      input,
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          input.source.checkpoint,
        ),
      ),
    );
}

export function capturePiDurableCheckpoint(
  sql: SqlStorage,
  input: EmbeddedHarnessConstructionInput,
  result: Pick<EmbeddedHarnessTurnResult, "cursor" | "historyCursor">,
): ArrayBuffer {
  const tables: NativeTable[] = [];
  for (const name of TABLES) {
    const columns = tableColumns(sql, name);
    const rows = sql
      .exec(`SELECT * FROM ${name}`)
      .toArray()
      .map(captureRow.bind(null, columns));
    tables.push({ name, columns, rows });
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      kind: PI_DURABLE_CHECKPOINT_FORMAT,
      sessionId: input.sessionId,
      binding: { ...input.checkpointBinding, cursor: result.cursor },
      historyCursor: result.historyCursor,
      tables,
    }),
  );
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function restorePiDurableCheckpoint(
  sql: SqlStorage,
  input: EmbeddedHarnessConstructionInput,
  raw: unknown,
): void {
  if (input.source.kind !== "restore") return;
  if (
    !isRecord(raw) ||
    raw.kind !== PI_DURABLE_CHECKPOINT_FORMAT ||
    raw.sessionId !== input.sessionId ||
    canonicalJson(raw.binding) !== canonicalJson(input.checkpointBinding) ||
    canonicalJson(raw.historyCursor) !==
      canonicalJson(input.source.historyCursor) ||
    !Array.isArray(raw.tables) ||
    raw.tables.length !== TABLES.length
  ) {
    throw new Error("embedded_harness_checkpoint_invalid");
  }
  const tables: NativeTable[] = [];
  for (const [index, name] of TABLES.entries()) {
    const candidate: unknown = raw.tables[index];
    const columns = tableColumns(sql, name);
    if (
      !isRecord(candidate) ||
      candidate.name !== name ||
      canonicalJson(candidate.columns) !== canonicalJson(columns) ||
      !Array.isArray(candidate.rows)
    )
      throw new Error("embedded_harness_checkpoint_invalid");
    const rows: Cell[][] = [];
    for (const rawRow of candidate.rows) {
      if (
        !Array.isArray(rawRow) ||
        rawRow.length !== columns.length ||
        !rawRow.every(isCell)
      )
        throw new Error("embedded_harness_checkpoint_invalid");
      rows.push(rawRow);
    }
    tables.push({ name, columns, rows });
  }
  for (const { name } of tables) sql.exec(`DELETE FROM ${name}`);
  for (const { name, columns, rows } of tables) {
    const placeholders = columns.map(placeholder).join(",");
    for (const row of rows)
      sql.exec(`INSERT INTO ${name} VALUES (${placeholders})`, ...row);
  }
  const schema = sql
    .exec<{ version: number }>(
      "SELECT version FROM durable_schema WHERE singleton = 1",
    )
    .one();
  if (schema.version !== CURRENT_SQLITE_SCHEMA_VERSION)
    throw new Error("embedded_harness_checkpoint_invalid");
}
function tableColumns(
  sql: SqlStorage,
  table: (typeof TABLES)[number],
): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map(columnName);
}
function columnName(row: { name: string }): string {
  return row.name;
}
function placeholder(): string {
  return "?";
}
function isCell(value: unknown): value is Cell {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function captureRow(
  columns: string[],
  row: Record<string, SqlStorageValue>,
): Cell[] {
  return columns.map(captureCell.bind(null, row));
}
function captureCell(
  row: Record<string, SqlStorageValue>,
  column: string,
): Cell {
  const value = row[column];
  if (!isCell(value)) throw new Error("Unsupported native SQLite cell");
  return value;
}
