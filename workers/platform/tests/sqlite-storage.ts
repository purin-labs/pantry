/// <reference types="@cloudflare/workers-types" />

import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";

type TestRow = Record<string, SqlStorageValue>;

export type SqlFailureMatcher = {
  queryIncludes: string;
  bindingIndex: number | null;
  bindingValue: SqlStorageValue | null;
};

class TestSqlCursor<Row extends TestRow> {
  constructor(
    private readonly rows: readonly Row[],
    private readonly written = 0,
  ) {}

  get rowsRead(): number {
    return this.rows.length;
  }

  /** The rows that a write changed, as workerd reports them. */
  get rowsWritten(): number {
    return this.written;
  }

  *[Symbol.iterator](): IterableIterator<Row> {
    yield* this.rows;
  }

  toArray(): Row[] {
    return [...this.rows];
  }
}

export class TestSqlStorage {
  private mutationCount = 0;
  private failMutation: number | null = null;
  private failMatcher: SqlFailureMatcher | null = null;

  constructor(private readonly database: DatabaseSync) {}

  exec<Row extends TestRow>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): TestSqlCursor<Row> {
    if (!isReadQuery(query)) {
      this.mutationCount += 1;
      this.injectFailureIfRequested(query, bindings);
    }

    const statement = this.database.prepare(query);

    if (isReadQuery(query)) {
      const rows = statement
        .all(...bindings.map(sqliteBinding))
        .map(cloudflareRow);
      return new TestSqlCursor<Row>(rows as Row[]);
    }

    if (hasReturningClause(query)) {
      const rows = statement
        .all(...bindings.map(sqliteBinding))
        .map(cloudflareRow);
      return new TestSqlCursor<Row>(rows as Row[]);
    }

    const result = statement.run(...bindings.map(sqliteBinding));
    return new TestSqlCursor<Row>([], Number(result.changes));
  }

  transactionSync<Value>(operation: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failOnceAtMutation(mutation: number): void {
    this.failMutation = mutation;
  }

  failOnceWhen(matcher: SqlFailureMatcher): void {
    this.failMatcher = matcher;
  }

  mutations(): number {
    return this.mutationCount;
  }

  private injectFailureIfRequested(
    query: string,
    bindings: readonly SqlStorageValue[],
  ): void {
    if (this.failMutation === this.mutationCount) {
      this.failMutation = null;
      throw new Error(`injected_sql_failure:${this.mutationCount}`);
    }

    const matcher = this.failMatcher;

    if (matcher === null || !query.includes(matcher.queryIncludes)) {
      return;
    }

    if (
      matcher.bindingIndex !== null &&
      bindings[matcher.bindingIndex] !== matcher.bindingValue
    ) {
      return;
    }

    this.failMatcher = null;
    throw new Error(`injected_sql_failure:${matcher.queryIncludes}`);
  }
}

export function emptySqliteFixture(): {
  database: DatabaseSync;
  storage: TestSqlStorage;
} {
  const database = new DatabaseSync(":memory:");
  return { database, storage: new TestSqlStorage(database) };
}

export function sqlStorage(storage: TestSqlStorage): SqlStorage {
  return storage as unknown as SqlStorage;
}

function isReadQuery(query: string): boolean {
  const operation = query.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
  return (
    operation === "SELECT" ||
    operation === "PRAGMA" ||
    operation === "WITH" ||
    operation === "EXPLAIN"
  );
}

function hasReturningClause(query: string): boolean {
  return /\bRETURNING\b/i.test(query);
}

function sqliteBinding(value: SqlStorageValue): SQLInputValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return value;
}

function cloudflareRow(row: Record<string, SQLOutputValue>): TestRow {
  const output: TestRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      const bytes = new Uint8Array(value.byteLength);
      bytes.set(value);
      output[key] = bytes.buffer;
    } else if (typeof value === "bigint") {
      throw new Error("Fixture SQLite returned an unsupported bigint");
    } else {
      output[key] = value;
    }
  }
  return output;
}
