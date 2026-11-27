import {
  COPY_EXCLUDED_SHARED_TABLES,
  PROVISIONED_SHARED_TABLE,
  RECEIPT_OWNER_COLUMN,
  RECEIPT_TABLE,
  sharedRowOwnerColumn,
} from "@purin-labs/tenancy/data/shared-rows/regional-copy-rules";
import { prepareRetiredCellOrganisationRow } from "@purin-labs/tenancy/data/shared-rows/organisation-row";
import { organisationRowsWhere } from "@purin-labs/tenancy/data/purge-catalogue";
import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type { Result } from "@purin-labs/kernel/result";
import { encodeBase64, isRecord } from "@purin-labs/std";
import type { ActorRelocationId } from "@purin-labs/tenancy/data/organisation-placement";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  ActorExportEnvelopeV1,
  ActorExportId,
  ActorExportR2Object,
} from "../actors/actor-export";
import { readPlacementByEpoch } from "@purin-labs/tenancy/data/organisation-placement";
import {
  ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS,
  type OrganisationPlacementFenceToken,
} from "@purin-labs/tenancy/data/organisation-placement";
import type { FrozenOrganisationPlacementMove } from "@purin-labs/tenancy/data/organisation-placement";

type Cell = string | number | null;
type CopyTable = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly keys: readonly string[];
  readonly parents: readonly string[];
  readonly predicate: string;
  readonly schema: string;
};
type CopyProgress = {
  readonly cursor: readonly Cell[];
  readonly rowCount: number;
  readonly digest: string;
  readonly verified: boolean;
};
type RegionalCopyInput = {
  readonly directory: GlobalDatabase;
  readonly source: OrganisationDatabase;
  readonly target: D1Database;
  readonly relocationId: ActorRelocationId;
  readonly move: FrozenOrganisationPlacementMove;
  readonly now: number;
};
const PAGE_SIZE = 20;
const ARCHIVE_PAGE_SIZE = 1_000;
// Directory records and global authority remain in their owning store.
const EXCLUDED = new Set([
  ...COPY_EXCLUDED_SHARED_TABLES,
  "durable_object_registry",
  "app_user",
  "control_oidc_state",
  "control_session",
  "control_support_role",
  "onboarding_support_access_audit",
  "provider_manifest",
  "slack_channel_default",
  "slack_channel_default_revision",
  "slack_dm_organisation_selection",
  "slack_dm_organisation_selection_audit_event",
  "slack_installation",
  "slack_installation_audit_event",
  "slack_installation_lifecycle_event",
  "slack_organisation_connection",
  "slack_routing_audit_event",
  "slack_thread_case_pin",
  "state_object_relocation",
  "state_object_relocation_copy",
  "state_object_relocation_item",
  "state_object_restore",
  "state_object_restore_item",
  "user_preferences",
  "vault_root_rotation_job",
]);

/** Discover columns from the regional schema; ownership is explicit and unknown ownership fails closed. */
export async function regionalCopyTables(
  database: D1Database,
  source: D1Database,
): Promise<readonly CopyTable[]> {
  const tables = await regionalSchemaTableNames(database);
  const sourceTables = await regionalSchemaTableNames(source);
  if (JSON.stringify(tables) !== JSON.stringify(sourceTables))
    throw new Error("regional_schema_tables_mismatch");
  const targetSchema = await readRegionalTableSchemas(database, tables);
  const sourceSchema =
    source === database
      ? targetSchema
      : await readRegionalTableSchemas(source, tables);
  const result: CopyTable[] = [];
  for (const name of tables) {
    const targetTable = targetSchema.get(name);
    const sourceTable = sourceSchema.get(name);
    if (targetTable === undefined || sourceTable === undefined)
      throw new Error("regional_schema_invalid");
    const columns = targetTable.columns;
    const names: string[] = [];
    const keys: { name: string; position: number }[] = [];
    for (const column of columns.results) {
      if (
        !isRecord(column) ||
        typeof column.name !== "string" ||
        typeof column.pk !== "number"
      )
        throw new Error("regional_schema_invalid");
      names.push(column.name);
      if (column.pk > 0) keys.push({ name: column.name, position: column.pk });
    }
    keys.sort(compareKeyPosition);
    if (keys.length === 0)
      throw new Error(`regional_primary_key_missing:${name}`);
    const sourceColumns = sourceTable.columns;
    if (
      JSON.stringify(columns.results) !== JSON.stringify(sourceColumns.results)
    ) {
      throw new Error(`regional_schema_mismatch:${name}`);
    }
    const foreignKeys = targetTable.foreignKeys;
    const sourceForeignKeys = sourceTable.foreignKeys;
    if (
      JSON.stringify(foreignKeys.results) !==
      JSON.stringify(sourceForeignKeys.results)
    )
      throw new Error(`regional_foreign_keys_mismatch:${name}`);
    const parents = new Set<string>();
    for (const key of foreignKeys.results) {
      if (!isRecord(key) || typeof key.table !== "string")
        throw new Error("regional_schema_invalid");
      if (key.table !== name && !EXCLUDED.has(key.table))
        parents.add(key.table);
    }
    result.push({
      name,
      columns: names,
      keys: keys.map(keyName),
      parents: [...parents],
      predicate: ownershipPredicate(name, names),
      schema: JSON.stringify({
        columns: columns.results,
        foreignKeys: foreignKeys.results,
      }),
    });
  }
  const ordered: CopyTable[] = [];
  const done = new Set<string>();
  while (ordered.length < result.length) {
    const before = ordered.length;
    for (const table of result) {
      if (done.has(table.name)) continue;
      let ready = true;
      for (const parent of table.parents) if (!done.has(parent)) ready = false;
      if (!ready) continue;
      ordered.push(table);
      done.add(table.name);
    }
    if (ordered.length === before)
      throw new Error("regional_schema_dependency_cycle");
  }
  return ordered;
}

type RegionalTableSchema = {
  readonly columns: D1Result;
  readonly foreignKeys: D1Result;
};

async function readRegionalTableSchemas(
  database: D1Database,
  names: readonly string[],
): Promise<ReadonlyMap<string, RegionalTableSchema>> {
  const schemas = new Map<string, RegionalTableSchema>();
  // Bound each request to 80 statements while avoiding a round trip per pragma.
  const tablesPerBatch = 40;
  for (let offset = 0; offset < names.length; offset += tablesPerBatch) {
    const batchNames = names.slice(offset, offset + tablesPerBatch);
    const statements: D1PreparedStatement[] = [];
    for (const name of batchNames) {
      statements.push(
        database.prepare(`PRAGMA table_info(${identifier(name)})`),
      );
      statements.push(
        database.prepare(`PRAGMA foreign_key_list(${identifier(name)})`),
      );
    }
    const results = await database.batch(statements);
    let resultIndex = 0;
    for (const name of batchNames) {
      const columns = results[resultIndex++];
      const foreignKeys = results[resultIndex++];
      if (columns === undefined || foreignKeys === undefined)
        throw new Error("regional_schema_invalid");
      schemas.set(name, { columns, foreignKeys });
    }
  }
  return schemas;
}

async function regionalSchemaTableNames(
  database: D1Database,
): Promise<readonly string[]> {
  const tables = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'context_projection_fts%' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name",
    )
    .all();
  const names: string[] = [];
  for (const raw of tables.results) {
    if (!isRecord(raw) || typeof raw.name !== "string")
      throw new Error("regional_schema_invalid");
    if (!EXCLUDED.has(raw.name)) names.push(raw.name);
  }
  return names;
}

export async function copyRegionalOrganisationData(
  input: RegionalCopyInput,
  tables: readonly CopyTable[],
): Promise<void> {
  const startedAt = Date.now();
  await requireCopyFences(input, input.now);
  const counts = await regionalOrganisationTableCounts(
    input.source,
    input.move.organisationId,
    tables,
  );
  const emptyTables: CopyTable[] = [];
  for (const table of tables) {
    if (counts.get(table.name) === 0) {
      emptyTables.push(table);
      continue;
    }
    let progress = await readProgress(input, table);
    if (progress.verified) continue;
    while (true) {
      await requireCopyFences(input, input.now + Date.now() - startedAt);
      const rows = await readPage(
        input.source,
        table,
        input.move.organisationId,
        progress.cursor,
        PAGE_SIZE,
      );
      if (rows.length === 0) break;
      await copyRows(input, table, rows);
      const cursor = rowKey(table, rows[rows.length - 1]);
      const digest = await digestRows(progress.digest, rows);
      progress = {
        cursor,
        rowCount: progress.rowCount + rows.length,
        digest,
        verified: false,
      };
      await input.directory
        .prepare(
          `INSERT INTO state_object_relocation_copy (relocation_id, table_name, cursor_json, row_count, content_digest, status, verified_at)
        VALUES (?, ?, ?, ?, ?, 'copying', NULL)
        ON CONFLICT (relocation_id, table_name) DO UPDATE SET cursor_json = excluded.cursor_json, row_count = excluded.row_count, content_digest = excluded.content_digest
        WHERE state_object_relocation_copy.status = 'copying'`,
        )
        .bind(
          input.relocationId,
          table.name,
          JSON.stringify(cursor),
          progress.rowCount,
          digest,
        )
        .run();
    }
  }
  // Verify every table after copying, including tables completed by an earlier
  // attempt. Target readiness is published only after this full comparison.
  for (const table of tables) {
    if (counts.get(table.name) === 0) continue;
    await verifyTable(
      input,
      table,
      await readProgress(input, table),
      startedAt,
    );
  }
  await verifyEmptyTables(input, emptyTables, startedAt);
}

async function verifyEmptyTables(
  input: RegionalCopyInput,
  tables: readonly CopyTable[],
  startedAt: number,
): Promise<void> {
  if (tables.length === 0) return;
  await requireCopyFences(input, input.now + Date.now() - startedAt);
  const [sourceCounts, targetCounts] = await Promise.all([
    regionalOrganisationTableCounts(
      input.source,
      input.move.organisationId,
      tables,
    ),
    regionalOrganisationTableCounts(
      input.target,
      input.move.organisationId,
      tables,
    ),
  ]);
  const statements: D1PreparedStatement[] = [];
  for (const table of tables) {
    if (
      sourceCounts.get(table.name) !== 0 ||
      targetCounts.get(table.name) !== 0
    )
      throw new Error(`regional_copy_mismatch:${table.name}`);
    statements.push(
      input.directory
        .prepare(
          `SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_object_relocation_copy WHERE relocation_id = ? AND table_name = ?
          AND (row_count != 0 OR content_digest != '' OR cursor_json != '[]')
      ) THEN 1 ELSE json_extract('regional_source_changed', '$') END`,
        )
        .bind(input.relocationId, table.name),
      input.directory
        .prepare(
          `INSERT INTO state_object_relocation_copy
        (relocation_id, table_name, cursor_json, row_count, content_digest, status, verified_at)
        VALUES (?, ?, '[]', 0, '', 'verified', ?)
        ON CONFLICT (relocation_id, table_name) DO UPDATE SET status = 'verified', verified_at = excluded.verified_at`,
        )
        .bind(input.relocationId, table.name, input.now),
    );
  }
  await input.directory.batch(statements);
  await requireCopyFences(input, input.now + Date.now() - startedAt);
}

async function verifyTable(
  input: RegionalCopyInput,
  table: CopyTable,
  progress: CopyProgress,
  startedAt: number,
): Promise<void> {
  let cursor: readonly Cell[] = [];
  let count = 0;
  let digest = "";
  while (true) {
    await requireCopyFences(input, input.now + Date.now() - startedAt);
    const [source, target] = await Promise.all([
      readPage(
        input.source,
        table,
        input.move.organisationId,
        cursor,
        PAGE_SIZE,
      ),
      readPage(
        input.target,
        table,
        input.move.organisationId,
        cursor,
        PAGE_SIZE,
      ),
    ]);
    if (JSON.stringify(source) !== JSON.stringify(target))
      throw new Error(`regional_copy_mismatch:${table.name}`);
    if (source.length === 0) break;
    count += source.length;
    digest = await digestRows(digest, source);
    cursor = rowKey(table, source[source.length - 1]);
  }
  if (count !== progress.rowCount || digest !== progress.digest)
    throw new Error(`regional_source_changed:${table.name}`);
  await input.directory
    .prepare(
      `INSERT INTO state_object_relocation_copy (relocation_id, table_name, cursor_json, row_count, content_digest, status, verified_at)
    VALUES (?, ?, ?, ?, ?, 'verified', ?)
    ON CONFLICT (relocation_id, table_name) DO UPDATE SET status = 'verified', verified_at = excluded.verified_at`,
    )
    .bind(
      input.relocationId,
      table.name,
      JSON.stringify(cursor),
      count,
      digest,
      input.now,
    )
    .run();
}

async function copyRows(
  input: RegionalCopyInput,
  table: CopyTable,
  rows: readonly (readonly Cell[])[],
): Promise<void> {
  if (table.name === "workspace_revision") {
    for (const row of rows) await copyRow(input, table, row, new Set());
    return;
  }
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) statements.push(copyRowStatement(input, table, row));
  await input.target.batch(statements);
}

async function copyRow(
  input: RegionalCopyInput,
  table: CopyTable,
  row: readonly Cell[],
  ancestors: Set<string>,
): Promise<void> {
  const key = rowKey(table, row);
  const existing = await input.target
    .prepare(
      `SELECT ${columnList(table.columns)} FROM ${identifier(table.name)} WHERE ${keyPredicate(table)}`,
    )
    .bind(...key)
    .first();
  if (existing !== null) {
    const values = persistenceRow(table, existing);
    if (JSON.stringify(values) === JSON.stringify(row)) return;
    if (table.name !== "workspace_ai_budget")
      throw new Error(`regional_target_conflict:${table.name}`);
  }
  if (table.name === "workspace_revision") {
    const identity = JSON.stringify(key);
    if (ancestors.has(identity))
      throw new Error("regional_workspace_history_cycle");
    ancestors.add(identity);
    const base = row[table.columns.indexOf("base_revision_id")];
    if (typeof base === "string") {
      const parent = await input.source
        .prepare(
          `SELECT ${columnList(table.columns)} FROM workspace_revision WHERE organisation_id = ? AND workspace_id = ? AND revision_id = ?`,
        )
        .bind(
          input.move.organisationId,
          row[table.columns.indexOf("workspace_id")],
          base,
        )
        .first();
      if (parent === null) throw new Error("regional_workspace_parent_missing");
      await copyRow(input, table, persistenceRow(table, parent), ancestors);
    }
  }
  await copyRowStatement(input, table, row).run();
}

function copyRowStatement(
  input: RegionalCopyInput,
  table: CopyTable,
  row: readonly Cell[],
): D1PreparedStatement {
  const placeholders = table.columns.map(placeholder).join(", ");
  const replacement =
    table.name === "workspace_ai_budget"
      ? `ON CONFLICT (${columnList(table.keys)}) DO UPDATE SET ${assignmentList(table.columns)}`
      : `ON CONFLICT (${columnList(table.keys)}) DO NOTHING`;
  return input.target
    .prepare(
      `INSERT INTO ${identifier(table.name)} (${columnList(table.columns)}) SELECT ${placeholders}
    WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'reserved') ${replacement}`,
    )
    .bind(
      ...row,
      input.move.organisationId,
      input.move.target.placement.placementEpoch,
      input.move.target.fenceToken,
    );
}

async function readPage(
  database: D1Database,
  table: CopyTable,
  organisationId: string,
  cursor: readonly Cell[],
  pageSize: number,
): Promise<readonly (readonly Cell[])[]> {
  const after =
    cursor.length === 0
      ? ""
      : `AND (${columnList(table.keys)}) > (${cursor.map(placeholder).join(", ")})`;
  const rows = await database
    .prepare(
      `SELECT ${columnList(table.columns)} FROM ${identifier(table.name)} WHERE ${table.predicate} ${after} ORDER BY ${columnList(table.keys)} LIMIT ?`,
    )
    .bind(organisationId, ...cursor, pageSize)
    .all();
  const values: (readonly Cell[])[] = [];
  for (const row of rows.results) values.push(persistenceRow(table, row));
  return values;
}

async function readProgress(
  input: RegionalCopyInput,
  table: CopyTable,
): Promise<CopyProgress> {
  const row = await input.directory
    .prepare(
      "SELECT cursor_json, row_count, content_digest, status FROM state_object_relocation_copy WHERE relocation_id = ? AND table_name = ?",
    )
    .bind(input.relocationId, table.name)
    .first();
  if (row === null)
    return { cursor: [], rowCount: 0, digest: "", verified: false };
  if (
    !isRecord(row) ||
    typeof row.cursor_json !== "string" ||
    typeof row.row_count !== "number" ||
    typeof row.content_digest !== "string" ||
    (row.status !== "copying" && row.status !== "verified")
  )
    throw new Error("regional_copy_progress_corrupt");
  const raw: unknown = JSON.parse(row.cursor_json);
  if (!Array.isArray(raw)) throw new Error("regional_copy_cursor_corrupt");
  const cursor: Cell[] = [];
  for (const value of raw) {
    if (!isCell(value)) throw new Error("regional_copy_cursor_corrupt");
    cursor.push(value);
  }
  if (cursor.length !== 0 && cursor.length !== table.keys.length)
    throw new Error("regional_copy_cursor_corrupt");
  return {
    cursor,
    rowCount: row.row_count,
    digest: row.content_digest,
    verified: row.status === "verified",
  };
}

async function requireCopyFences(
  input: RegionalCopyInput,
  now: number,
): Promise<void> {
  const sourceRead = input.source
    .prepare(
      "SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'frozen'",
    )
    .bind(
      input.move.organisationId,
      input.move.source.placement.placementEpoch,
      input.move.source.fenceToken,
    )
    .first();
  const targetRead = input.target
    .prepare(
      "SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'reserved'",
    )
    .bind(
      input.move.organisationId,
      input.move.target.placement.placementEpoch,
      input.move.target.fenceToken,
    )
    .first();
  const journalRead = input.directory
    .prepare(
      `SELECT 1 FROM state_object_relocation operation
        WHERE relocation_id = ? AND organisation_id = ? AND status IN ('frozen', 'copying')
          AND (frozen_at > ? OR EXISTS (SELECT 1 FROM state_object_relocation abandoned
            WHERE abandoned.status = 'abandoned' AND abandoned.recovery_relocation_id = operation.relocation_id))`,
    )
    .bind(
      input.relocationId,
      input.move.organisationId,
      now - ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS,
    )
    .first();
  const [source, target, journal] = await Promise.all([
    sourceRead,
    targetRead,
    journalRead,
  ]);
  if (source === null || target === null || journal === null)
    throw new Error("regional_copy_fence_conflict");
}

function ownershipPredicate(name: string, columns: readonly string[]): string {
  if (columns.includes("organisation_id")) return '"organisation_id" = ?';
  if (name === RECEIPT_TABLE) return `"${RECEIPT_OWNER_COLUMN}" = ?`;
  // A child table selects its rows through its parent, as the purge does.
  const where = organisationRowsWhere(name);
  if (where === undefined)
    throw new Error(`regional_ownership_unknown:${name}`);
  return where;
}
function persistenceRow(table: CopyTable, raw: unknown): readonly Cell[] {
  if (!isRecord(raw)) throw new Error("regional_row_invalid");
  const values: Cell[] = [];
  for (const column of table.columns) {
    const value = raw[column];
    if (!isCell(value))
      throw new Error(`regional_value_unsupported:${table.name}.${column}`);
    values.push(value);
  }
  return values;
}
function isCell(value: unknown): value is Cell {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function rowKey(
  table: CopyTable,
  row: readonly Cell[] | undefined,
): readonly Cell[] {
  if (!row) throw new Error("regional_row_missing");
  const values: Cell[] = [];
  for (const key of table.keys) {
    const value = row[table.columns.indexOf(key)];
    if (value === undefined || value === null)
      throw new Error("regional_key_invalid");
    values.push(value);
  }
  return values;
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error(`regional_identifier_invalid:${value}`);
  return `"${value}"`;
}
function columnList(columns: readonly string[]): string {
  return columns.map(identifier).join(", ");
}
function keyPredicate(table: CopyTable): string {
  return table.keys.map(keyEquality).join(" AND ");
}
function keyEquality(key: string): string {
  return `${identifier(key)} = ?`;
}
function assignmentList(columns: readonly string[]): string {
  return columns.map(columnAssignment).join(", ");
}
function columnAssignment(column: string): string {
  return `${identifier(column)} = excluded.${identifier(column)}`;
}
function placeholder(): string {
  return "?";
}
function compareKeyPosition(
  a: { position: number },
  b: { position: number },
): number {
  return a.position - b.position;
}
function keyName(key: { name: string }): string {
  return key.name;
}
async function digestRows(
  previous: string,
  rows: readonly (readonly Cell[])[],
): Promise<string> {
  return encodeBase64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([previous, rows])),
      ),
    ),
  );
}

/** Delete only an inactive copy; keep the root required by placement and registry tombstones. */
export async function deleteInactiveRegionalOrganisationData(input: {
  readonly database: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly placementEpoch: number;
  readonly inactiveStatus: "retired" | "abandoned";
  readonly placementFenceToken: OrganisationPlacementFenceToken;
}): Promise<void> {
  const tables = await regionalCopyTables(input.database, input.database);
  const statements: D1PreparedStatement[] = [
    input.database.prepare("PRAGMA defer_foreign_keys = ON"),
  ];
  for (const table of [...tables].reverse()) {
    if (table.name === PROVISIONED_SHARED_TABLE) continue;
    statements.push(
      input.database
        .prepare(
          `DELETE FROM ${identifier(table.name)} WHERE ${table.predicate}`,
        )
        .bind(input.organisationId),
    );
  }
  statements.push(
    prepareRetiredCellOrganisationRow(input.database, input.organisationId),
  );
  statements.push(
    input.database
      .prepare(
        `SELECT CASE WHEN EXISTS (
    SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
      AND fence_token = ? AND status = ?
  ) AND NOT EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND status NOT IN ('retired', 'abandoned'))
  THEN 1 ELSE json_extract('regional_cleanup_fence_conflict', '$') END`,
      )
      .bind(
        input.organisationId,
        input.placementEpoch,
        input.placementFenceToken,
        input.inactiveStatus,
        input.organisationId,
      ),
  );
  await input.database.batch(statements);
}

export async function countRegionalOrganisationRows(
  database: D1Database,
  organisationId: OrganisationId,
  tables: readonly CopyTable[],
): Promise<number> {
  const counts = await regionalOrganisationTableCounts(
    database,
    organisationId,
    tables,
  );
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

async function regionalOrganisationTableCounts(
  database: D1Database,
  organisationId: OrganisationId,
  tables: readonly CopyTable[],
): Promise<ReadonlyMap<string, number>> {
  const statements: D1PreparedStatement[] = [];
  for (const table of tables) {
    statements.push(
      database
        .prepare(
          `SELECT COUNT(*) AS total FROM ${identifier(table.name)} WHERE ${table.predicate}`,
        )
        .bind(organisationId),
    );
  }
  const counts = new Map<string, number>();
  if (statements.length === 0) return counts;
  const rows = await database.batch<{ total: number }>(statements);
  for (const [index, table] of tables.entries()) {
    const row = rows[index]?.results[0];
    if (row === undefined || !Number.isSafeInteger(row.total) || row.total < 0)
      throw new Error("regional_inventory_invalid");
    counts.set(table.name, row.total);
  }
  return counts;
}

/** Capture only organisation-owned rows. The Actor envelope authenticates these page objects. */
export async function captureOrganisationDataArchive(
  database: D1Database,
  bucket: R2Bucket,
  organisationId: OrganisationId,
  exportId: ActorExportId,
): Promise<readonly string[]> {
  const tables = await regionalCopyTables(database, database);
  const keys: string[] = [];
  try {
    const concurrency = 6;
    for (let offset = 0; offset < tables.length; offset += concurrency) {
      const pending: Promise<readonly string[]>[] = [];
      for (const table of tables.slice(offset, offset + concurrency))
        pending.push(
          captureOrganisationTableArchive(
            database,
            bucket,
            organisationId,
            exportId,
            table,
          ),
        );
      const results = await Promise.allSettled(pending);
      for (const result of results)
        if (result.status === "fulfilled") keys.push(...result.value);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }
    return keys;
  } catch (error) {
    await deleteOrganisationDataArchivePages(bucket, keys);
    throw error;
  }
}

async function captureOrganisationTableArchive(
  database: D1Database,
  bucket: R2Bucket,
  organisationId: OrganisationId,
  exportId: ActorExportId,
  table: CopyTable,
): Promise<readonly string[]> {
  const keys: string[] = [];
  let cursor: readonly Cell[] = [];
  let page = 0;
  try {
    while (true) {
      const rows = await readPage(
        database,
        table,
        organisationId,
        cursor,
        ARCHIVE_PAGE_SIZE,
      );
      const last = rows.length < ARCHIVE_PAGE_SIZE;
      const key = `${organisationDataArchivePrefix(organisationId, exportId)}${table.name}/${String(page).padStart(8, "0")}.json`;
      keys.push(key);
      await bucket.put(
        key,
        JSON.stringify({
          organisationId,
          table: table.name,
          schema: table.schema,
          columns: table.columns,
          rows,
          last,
        }),
      );
      if (last) return keys;
      cursor = rowKey(table, rows.at(-1));
      page += 1;
    }
  } catch (error) {
    await deleteOrganisationDataArchivePages(bucket, keys);
    throw error;
  }
}

export async function deleteOrganisationDataArchivePages(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 100)
    await bucket.delete(keys.slice(offset, offset + 100));
}

/** Fill a reserved recovery placement from a verified Actor export. Never replace other organisations' rows. */
export async function restoreOrganisationDataArchive(input: {
  readonly directory: D1Database;
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly envelope: ActorExportEnvelopeV1;
  readonly targetPlacementEpoch: number;
}): Promise<void> {
  const organisationId = input.envelope.payload.source.identity.organisationId;
  if (
    input.envelope.payload.source.identity.objectKind !== "organisation" ||
    input.targetPlacementEpoch <= input.envelope.payload.source.placementEpoch
  )
    throw new Error("regional_backup_identity_conflict");
  const target = await readPlacementByEpoch(
    input.directory,
    organisationId,
    input.targetPlacementEpoch,
  );
  if (!target.ok || target.value.status !== "reserved")
    throw new Error("regional_backup_fence_conflict");
  const tables = await regionalCopyTables(input.database, input.database);
  const prefix = organisationDataArchivePrefix(
    organisationId,
    input.envelope.payload.exportId,
  );
  const objects = input.envelope.payload.r2.filter(
    isOrganisationDataArchiveObject.bind(null, prefix),
  );
  const restoredKeys = new Set<string>();
  const expectedDigests = new Map<string, string>();
  for (const table of tables) {
    const tablePrefix = `${prefix}${table.name}/`;
    const pages = objects
      .filter(isOrganisationDataArchiveObject.bind(null, tablePrefix))
      .sort(compareArchiveKeys);
    if (pages.length === 0)
      throw new Error(`regional_backup_table_missing:${table.name}`);
    const rows: (readonly Cell[])[] = [];
    let expectedDigest = "";
    for (const [page, object] of pages.entries()) {
      if (
        object.sourceKey !==
        `${tablePrefix}${String(page).padStart(8, "0")}.json`
      )
        throw new Error("regional_backup_page_missing");
      const raw = await readOrganisationDataArchivePage(input.bucket, object);
      if (
        !isRecord(raw) ||
        raw.organisationId !== organisationId ||
        raw.table !== table.name ||
        raw.schema !== table.schema ||
        JSON.stringify(raw.columns) !== JSON.stringify(table.columns) ||
        raw.last !== (page === pages.length - 1) ||
        !Array.isArray(raw.rows) ||
        raw.rows.length > ARCHIVE_PAGE_SIZE ||
        (!raw.last && raw.rows.length === 0)
      )
        throw new Error(`regional_backup_schema_mismatch:${table.name}`);
      for (const value of raw.rows) {
        if (!Array.isArray(value) || value.length !== table.columns.length)
          throw new Error("regional_backup_row_invalid");
        const row: Cell[] = [];
        for (const cell of value) {
          if (!isCell(cell)) throw new Error("regional_backup_row_invalid");
          row.push(cell);
        }
        const organisationColumn = table.columns.indexOf(
          sharedRowOwnerColumn(table.name),
        );
        if (
          organisationColumn >= 0 &&
          row[organisationColumn] !== organisationId
        )
          throw new Error("regional_backup_organisation_mismatch");
        rows.push(row);
      }
      restoredKeys.add(object.sourceKey);
    }
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE)
      expectedDigest = await digestRows(
        expectedDigest,
        rows.slice(offset, offset + PAGE_SIZE),
      );
    expectedDigests.set(table.name, expectedDigest);
    const orderedRows = orderBackupRows(table, rows);
    for (let offset = 0; offset < orderedRows.length; offset += PAGE_SIZE) {
      const batch = orderedRows.slice(offset, offset + PAGE_SIZE);
      const reads: D1PreparedStatement[] = [];
      for (const row of batch) {
        reads.push(
          input.database
            .prepare(
              `SELECT ${columnList(table.columns)} FROM ${identifier(table.name)} WHERE ${keyPredicate(table)}`,
            )
            .bind(...rowKey(table, row)),
        );
      }
      const existing = await input.database.batch(reads);
      const writes: D1PreparedStatement[] = [];
      for (const [index, row] of batch.entries()) {
        const result = existing[index];
        if (result === undefined)
          throw new Error("regional_backup_read_missing");
        const current = result.results[0];
        if (current !== undefined) {
          if (
            JSON.stringify(persistenceRow(table, current)) !==
            JSON.stringify(row)
          )
            throw new Error(`regional_backup_target_conflict:${table.name}`);
          continue;
        }
        writes.push(
          input.database
            .prepare(
              `INSERT INTO ${identifier(table.name)} (${columnList(table.columns)}) VALUES (${row.map(placeholder).join(", ")})`,
            )
            .bind(...row),
        );
      }
      if (writes.length === 0) continue;
      writes.push(
        input.database
          .prepare(
            `SELECT CASE WHEN EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
            AND placement_epoch = ? AND fence_token = ? AND status = 'reserved')
            AND NOT EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND status = 'active')
            THEN 1 ELSE json_extract('regional_backup_fence_conflict', '$') END`,
          )
          .bind(
            organisationId,
            input.targetPlacementEpoch,
            target.value.fenceToken,
            organisationId,
          ),
      );
      await input.database.batch(writes);
    }
  }
  if (restoredKeys.size !== objects.length)
    throw new Error("regional_backup_unknown_table");
  // Check final contents after every table is restored, including trigger effects.
  for (const table of tables) {
    let cursor: readonly Cell[] = [];
    let digest = "";
    while (true) {
      const rows = await readPage(
        input.database,
        table,
        organisationId,
        cursor,
        ARCHIVE_PAGE_SIZE,
      );
      if (rows.length === 0) break;
      for (let offset = 0; offset < rows.length; offset += PAGE_SIZE)
        digest = await digestRows(
          digest,
          rows.slice(offset, offset + PAGE_SIZE),
        );
      cursor = rowKey(table, rows.at(-1));
    }
    if (digest !== expectedDigests.get(table.name))
      throw new Error(`regional_backup_target_conflict:${table.name}`);
  }
  const current = await readPlacementByEpoch(
    input.directory,
    organisationId,
    input.targetPlacementEpoch,
  );
  if (
    !current.ok ||
    current.value.status !== "reserved" ||
    current.value.fenceToken !== target.value.fenceToken
  )
    throw new Error("regional_backup_fence_conflict");
  await deleteOrganisationDataArchivePages(input.bucket, [...restoredKeys]);
}

export function organisationDataArchivePrefix(
  organisationId: OrganisationId,
  exportId: ActorExportId,
): string {
  return `state-object-organisation-data-v1/${organisationId}/${exportId}/`;
}

function isOrganisationDataArchiveObject(
  prefix: string,
  object: ActorExportR2Object,
): boolean {
  return object.sourceKey.startsWith(prefix);
}

function compareArchiveKeys(
  left: ActorExportR2Object,
  right: ActorExportR2Object,
): number {
  return left.sourceKey.localeCompare(right.sourceKey);
}

async function readOrganisationDataArchivePage(
  bucket: R2Bucket,
  object: ActorExportR2Object,
): Promise<unknown> {
  const saved = await bucket.get(object.archiveKey);
  if (saved === null) throw new Error("regional_backup_page_missing");
  const bytes = await saved.arrayBuffer();
  const digest = encodeBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
  if (bytes.byteLength !== object.size || digest !== object.digestB64)
    throw new Error("regional_backup_page_corrupt");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
}

function orderBackupRows(
  table: CopyTable,
  rows: readonly (readonly Cell[])[],
): readonly (readonly Cell[])[] {
  if (table.name !== "workspace_revision") return rows;
  const pending = new Map<string, readonly Cell[]>();
  const ordered: (readonly Cell[])[] = [];
  const complete = new Set<string>();
  for (const row of rows) pending.set(JSON.stringify(rowKey(table, row)), row);
  while (pending.size > 0) {
    const before = pending.size;
    for (const [key, row] of pending) {
      const base = row[table.columns.indexOf("base_revision_id")];
      const parent = JSON.stringify([
        row[table.columns.indexOf("organisation_id")],
        row[table.columns.indexOf("workspace_id")],
        base,
      ]);
      if (base !== null && !complete.has(parent)) continue;
      ordered.push(row);
      complete.add(key);
      pending.delete(key);
    }
    if (before === pending.size)
      throw new Error("regional_workspace_history_cycle");
  }
  return ordered;
}

// Workers Paid D1 limit: https://developers.cloudflare.com/d1/platform/limits/
const REGIONAL_DATABASE_CAPACITY_BYTES = 10_000_000_000;

export type RegionalCopyCapacityError =
  | { readonly code: "regional_capacity_unavailable" }
  | {
      readonly code: "regional_capacity_insufficient";
      readonly sourceDatabaseBytes: number;
      readonly targetDatabaseBytes: number;
      readonly limitBytes: number;
    };

export async function inspectRegionalCopyCapacity(
  source: D1Database,
  target: D1Database,
): Promise<
  Result<
    {
      readonly sourceDatabaseBytes: number;
      readonly targetDatabaseBytes: number;
      readonly limitBytes: number;
    },
    RegionalCopyCapacityError
  >
> {
  const sourceResult = await source
    .withSession("first-primary")
    .prepare("SELECT 1")
    .all();
  const targetResult =
    source === target
      ? sourceResult
      : await target.withSession("first-primary").prepare("SELECT 1").all();
  const sourceDatabaseBytes = sourceResult.meta.size_after;
  const targetDatabaseBytes = targetResult.meta.size_after;
  if (
    !Number.isSafeInteger(sourceDatabaseBytes) ||
    sourceDatabaseBytes < 0 ||
    !Number.isSafeInteger(targetDatabaseBytes) ||
    targetDatabaseBytes < 0
  )
    return { ok: false, error: { code: "regional_capacity_unavailable" } };
  const projectedBytes =
    targetDatabaseBytes + (source === target ? 0 : sourceDatabaseBytes);
  if (projectedBytes >= REGIONAL_DATABASE_CAPACITY_BYTES)
    return {
      ok: false,
      error: {
        code: "regional_capacity_insufficient",
        sourceDatabaseBytes,
        targetDatabaseBytes,
        limitBytes: REGIONAL_DATABASE_CAPACITY_BYTES,
      },
    };
  return {
    ok: true,
    value: {
      sourceDatabaseBytes,
      targetDatabaseBytes,
      limitBytes: REGIONAL_DATABASE_CAPACITY_BYTES,
    },
  };
}
