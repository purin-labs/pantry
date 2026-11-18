import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { singleDatabase, type SingleDatabase } from "../src/database-handles";
import type { OrganisationId } from "../src/ids";
import type { OrganisationPlacement } from "../src/placement";
import type { ActorRegistryId } from "../src/actors/actor-registry";
import { readRegistryEntryById } from "../src/actors/actor-registry";
import { resolveActorExecutionAdmission } from "../src/actors/actor-placement-admission";

/**
 * The SQL of the one-database schema that holds both deployed baselines.
 * `0001_current_schema.sql` is the only name.
 */
export function readMigration(name: string): string {
  if (name !== "0001_current_schema.sql")
    throw new Error(`unknown migration ${name}`);
  return singleDatabaseSchema();
}

/**
 * A D1 database over in-memory SQLite with both baselines applied. Pass a
 * DatabaseSync to keep direct access to the underlying SQLite handle.
 */
export function createMigratedDatabase(
  sqlite: DatabaseSync = new DatabaseSync(":memory:"),
): SingleDatabase {
  sqlite.exec(singleDatabaseSchema());
  return d1Database(sqlite);
}

/**
 * D1 over an existing SQLite handle. It holds both schemas, so it serves as
 * the global database and as every Organisation's database.
 */
export function d1Database(sqlite: DatabaseSync): SingleDatabase {
  // The adapter implements the subset of D1 the platform uses.
  return singleDatabase(
    new SqliteD1Database(sqlite) as unknown as SingleDatabase,
  );
}

export async function requireActorExecutionAdmission(
  db: SingleDatabase,
  organisationId: OrganisationId,
  placement: OrganisationPlacement,
) {
  const admission = await resolveActorExecutionAdmission(
    db,
    organisationId,
    placement,
  );
  if (!admission.ok) throw new Error(admission.error.code);
  return admission.value;
}

export async function requireActorRegistryAdmission(
  db: SingleDatabase,
  registryId: ActorRegistryId,
) {
  const entry = await readRegistryEntryById(
    db.withSession("first-primary"),
    registryId,
  );
  if (!entry.ok) throw new Error(entry.error.code);
  return requireActorExecutionAdmission(
    db,
    entry.value.identity.organisationId,
    entry.value.placement,
  );
}

export class SqliteD1Database {
  private batches: Promise<unknown> = Promise.resolve();

  constructor(readonly database: DatabaseSync) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query, []);
  }

  async exec(query: string): Promise<D1ExecResult> {
    const startedAt = performance.now();
    this.database.exec(query);
    return { count: 1, duration: performance.now() - startedAt };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  withSession(
    _constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): SqliteD1Database {
    return this;
  }

  getBookmark(): string | null {
    return null;
  }

  /** As in D1, a batch is one transaction and batches run one at a time. */
  batch<T = unknown>(statements: SqliteD1Statement[]): Promise<D1Result<T>[]> {
    const batch = this.batches.then(this.runBatch.bind(this, statements));
    this.batches = batch.catch(ignoreEarlierBatchFailure);
    return batch as Promise<D1Result<T>[]>;
  }

  private async runBatch<T = unknown>(
    statements: SqliteD1Statement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.batchResult<T>());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A failed batch reports to its own caller and does not block the next. */
function ignoreEarlierBatchFailure(): void {}

export class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: readonly unknown[],
  ) {}

  private get statement(): StatementSync {
    return this.database.prepare(this.query);
  }

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.query, values);
  }

  /** As in D1, a batched statement that reads rows returns them. */
  async batchResult<T>(): Promise<D1Result<T>> {
    return !schemaStatement(this.query) && this.statement.columns().length > 0
      ? this.all<T>()
      : this.run<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = schemaStatement(this.query)
      ? this.executeSchema()
      : this.statement.run(...this.values.map(sqliteInputValue));
    return {
      success: true,
      results: [],
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        changed_db: result.changes > 0,
        changes: Number(result.changes),
      },
    };
  }

  private executeSchema(): { changes: number; lastInsertRowid: number } {
    this.database.exec(this.query);
    return { changes: 0, lastInsertRowid: 0 };
  }

  first<TResult = unknown>(colName: string): Promise<TResult | null>;
  first<TResult = Record<string, unknown>>(): Promise<TResult | null>;
  async first(colName?: string): Promise<unknown> {
    const row = this.statement.get(...this.values.map(sqliteInputValue));
    if (row === undefined) return null;
    return colName === undefined ? row : (row[colName] ?? null);
  }

  all<TResult = Record<string, unknown>>(): Promise<D1Result<TResult>>;
  async all(): Promise<D1Result<unknown>> {
    const rows = this.statement.all(...this.values.map(sqliteInputValue));
    return {
      success: true,
      results: rows,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  raw<TResult = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...TResult[]]>;
  raw<TResult = unknown[]>(options?: {
    columnNames?: false;
  }): Promise<TResult[]>;
  async raw(options?: { columnNames?: boolean }): Promise<unknown> {
    const rows = this.statement.all(...this.values.map(sqliteInputValue));
    const values = rows.map(Object.values);
    if (options?.columnNames !== true) return values;
    const columns = this.statement.columns().map((column) => column.name);
    return [columns, ...values];
  }
}

function sqliteInputValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  throw new TypeError("unsupported SQLite fixture binding");
}

/** D1 accepts a complete migration fragment, including several trigger definitions. */
function schemaStatement(query: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(query);
}
