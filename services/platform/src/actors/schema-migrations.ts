import type { CountRow } from "./sql-rows";
import { errorMessage } from "@purin-labs/std";

type SchemaMigrationStep = {
  version: number;
  apply: (sql: SqlStorage) => void;
  validate: (sql: SqlStorage) => void;
  rowCountGrowthAllowedTables?: readonly string[];
};

/**
 * One schema migration path for an actor's SQLite state (Refactor 10, step 2).
 * A new actor applies `baseline`, then each step. An actor at a stored version
 * at or above the baseline applies only the steps above it. An actor at a
 * stored version below the baseline holds a retired shape and cannot start.
 */
export type SchemaMigrationPlan = {
  key: string;
  currentVersion: number;
  preservedTables: readonly string[];
  /** The whole schema of `baseline.version`, created on empty storage. */
  baseline: SchemaMigrationStep;
  /** The steps after the baseline: baseline.version + 1, + 2, and so on. */
  steps: readonly SchemaMigrationStep[];
};

export type SchemaTransaction = <Value>(operation: () => Value) => Value;

type SchemaVersionRow = Record<string, SqlStorageValue> & {
  value: number;
};

type TableInfoRow = Record<string, SqlStorageValue> & {
  name: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function runSchemaMigrations(
  sql: SqlStorage,
  plan: SchemaMigrationPlan,
  transaction: SchemaTransaction,
): void {
  validatePlan(plan);
  createMigrationMetadata(sql);

  const storedVersion = readSchemaVersion(sql, plan.key);

  if (storedVersion > plan.currentVersion) {
    throw new Error(
      `schema_version_ahead:${plan.key}:${storedVersion}:${plan.currentVersion}`,
    );
  }

  if (storedVersion !== 0 && storedVersion < plan.baseline.version) {
    throw new Error(
      `schema_version_retired:${plan.key}:${storedVersion}:${plan.baseline.version}`,
    );
  }

  let version = storedVersion;

  if (version === 0) {
    runMigrationStep(sql, plan, plan.baseline, transaction);
    version = plan.baseline.version;
  }

  for (const step of plan.steps) {
    if (step.version <= version) {
      continue;
    }

    runMigrationStep(sql, plan, step, transaction);
    version = step.version;
  }

  const finalStep = plan.steps[plan.steps.length - 1] ?? plan.baseline;

  if (version !== plan.currentVersion) {
    throw new Error(
      `schema_plan_incomplete:${plan.key}:${version}:${plan.currentVersion}`,
    );
  }

  validateCurrentSchema(sql, plan, finalStep);
}

function readSchemaVersion(sql: SqlStorage, key: string): number {
  createMigrationMetadata(sql);
  const rows = sql
    .exec<SchemaVersionRow>(
      `SELECT value
       FROM do_schema_meta
       WHERE key = ?
       LIMIT 1`,
      key,
    )
    .toArray();
  const value = rows[0]?.value;

  return typeof value === "number" ? value : 0;
}

function tableHasColumn(
  sql: SqlStorage,
  table: string,
  column: string,
): boolean {
  requireIdentifier(table);
  requireIdentifier(column);
  const rows = sql.exec<TableInfoRow>(`PRAGMA table_info(${table})`).toArray();

  for (const row of rows) {
    if (row.name === column) {
      return true;
    }
  }

  return false;
}

export function assertRequiredColumns(
  sql: SqlStorage,
  table: string,
  columns: readonly string[],
): void {
  requireIdentifier(table);

  for (const column of columns) {
    if (!tableHasColumn(sql, table, column)) {
      throw new Error(`schema_column_missing:${table}:${column}`);
    }
  }
}

export function assertTableExists(sql: SqlStorage, table: string): void {
  requireIdentifier(table);

  if (!tableExists(sql, table)) {
    throw new Error(`schema_table_missing:${table}`);
  }
}

function runMigrationStep(
  sql: SqlStorage,
  plan: SchemaMigrationPlan,
  step: SchemaMigrationStep,
  transaction: SchemaTransaction,
): void {
  const rowCounts = readPreservedRowCounts(sql, plan.preservedTables);
  writeMigrationState(sql, plan.key, step.version, "applying", null);

  try {
    transaction(executeMigrationStep.bind(null, sql, plan, step, rowCounts));
  } catch (error) {
    recordMigrationFailure(sql, plan.key, step.version, error);
    throw error;
  }
}

function executeMigrationStep(
  sql: SqlStorage,
  plan: SchemaMigrationPlan,
  step: SchemaMigrationStep,
  rowCounts: ReadonlyMap<string, number>,
): void {
  step.apply(sql);
  step.validate(sql);
  assertPreservedRowCounts(
    sql,
    rowCounts,
    step.rowCountGrowthAllowedTables ?? [],
  );
  writeSchemaVersion(sql, plan.key, step.version);
  clearMigrationState(sql, plan.key);
}

function validateCurrentSchema(
  sql: SqlStorage,
  plan: SchemaMigrationPlan,
  finalStep: SchemaMigrationStep,
): void {
  try {
    finalStep.validate(sql);
    clearMigrationState(sql, plan.key);
  } catch (error) {
    recordMigrationFailure(sql, plan.key, plan.currentVersion, error);
    throw error;
  }
}

function validatePlan(plan: SchemaMigrationPlan): void {
  if (
    plan.key.length === 0 ||
    plan.currentVersion < 1 ||
    plan.baseline.version < 1
  ) {
    throw new Error(`schema_plan_invalid:${plan.key}`);
  }

  let expectedVersion = plan.baseline.version + 1;

  for (const step of plan.steps) {
    if (step.version !== expectedVersion) {
      throw new Error(
        `schema_plan_non_monotonic:${plan.key}:${step.version}:${expectedVersion}`,
      );
    }

    expectedVersion += 1;
  }

  if (expectedVersion - 1 !== plan.currentVersion) {
    throw new Error(`schema_plan_version_mismatch:${plan.key}`);
  }

  for (const table of plan.preservedTables) {
    requireIdentifier(table);
  }

  for (const step of [plan.baseline, ...plan.steps]) {
    for (const table of step.rowCountGrowthAllowedTables ?? []) {
      requireIdentifier(table);

      if (!plan.preservedTables.includes(table)) {
        throw new Error(
          `schema_growth_policy_not_preserved:${plan.key}:${step.version}:${table}`,
        );
      }
    }
  }
}

function createMigrationMetadata(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS do_schema_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS do_schema_migration (
      key TEXT PRIMARY KEY,
      target_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applying', 'failed')),
      error TEXT
    )`,
  );
}

function writeSchemaVersion(
  sql: SqlStorage,
  key: string,
  version: number,
): void {
  sql.exec(
    `INSERT INTO do_schema_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    version,
  );
}

function writeMigrationState(
  sql: SqlStorage,
  key: string,
  targetVersion: number,
  state: "applying" | "failed",
  error: string | null,
): void {
  sql.exec(
    `INSERT INTO do_schema_migration (key, target_version, state, error)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       target_version = excluded.target_version,
       state = excluded.state,
       error = excluded.error`,
    key,
    targetVersion,
    state,
    error,
  );
}

function clearMigrationState(sql: SqlStorage, key: string): void {
  sql.exec(
    `DELETE FROM do_schema_migration
     WHERE key = ?`,
    key,
  );
}

function recordMigrationFailure(
  sql: SqlStorage,
  key: string,
  targetVersion: number,
  error: unknown,
): void {
  try {
    writeMigrationState(sql, key, targetVersion, "failed", errorMessage(error));
  } catch {
    return;
  }
}

function readPreservedRowCounts(
  sql: SqlStorage,
  tables: readonly string[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const table of tables) {
    if (tableExists(sql, table)) {
      counts.set(table, readTableRowCount(sql, table));
    }
  }

  return counts;
}

function assertPreservedRowCounts(
  sql: SqlStorage,
  expected: ReadonlyMap<string, number>,
  growthAllowedTables: readonly string[],
): void {
  for (const [table, count] of expected) {
    const current = readTableRowCount(sql, table);

    if (
      growthAllowedTables.includes(table) ? current < count : current !== count
    ) {
      throw new Error(`schema_row_count_changed:${table}:${count}:${current}`);
    }
  }
}

function readTableRowCount(sql: SqlStorage, table: string): number {
  requireIdentifier(table);
  const rows = sql
    .exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)
    .toArray();
  const count = rows[0]?.count;

  if (typeof count !== "number") {
    throw new Error(`schema_row_count_invalid:${table}`);
  }

  return count;
}

function tableExists(sql: SqlStorage, table: string): boolean {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = ?
       LIMIT 1`,
      table,
    )
    .toArray();

  return rows.length > 0;
}

function requireIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`schema_identifier_invalid:${value}`);
  }
}
