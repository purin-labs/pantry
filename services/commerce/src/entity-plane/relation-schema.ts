import type { CommerceDatabase, CommerceSqlValue } from "../database.ts";

export function normalizeRelationSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

export function assertExactRelationColumns(
  database: CommerceDatabase,
  relationName: string,
  expectedColumns: readonly string[],
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${relationName})`)
    .all<Readonly<{ name: string }>>()
    .map((row) => row.name);
  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => column !== expectedColumns[index])
  ) {
    throw new Error(`${relationName} columns drifted`);
  }
}

export function relationTableHasIndex(
  database: CommerceDatabase,
  tableName: string,
  indexName: string,
): boolean {
  return database
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all<Readonly<{ name: string }>>()
    .some((row) => row.name === indexName);
}

/** One owner's rows in a table that Commerce derives from other tables. */
export type DerivedRelationRows = Readonly<{
  table: string;
  /** Every column of the table, in the order of each row's values. */
  columns: readonly string[];
  /** The table's primary key. */
  keyColumns: readonly string[];
  /** Selects the owner's rows, for example `merchant_id = ?` or `1 = 1`. */
  ownerPredicate: string;
  ownerBindings: readonly CommerceSqlValue[];
}>;

/**
 * Makes the owner's rows equal to `desired` and writes only the rows that
 * differ. Durable Object SQLite bills every written row and index entry, and a
 * merchant object refreshes its derived relations each time it starts, so a
 * refresh that finds no change must write nothing.
 */
export function syncDerivedRelationRows(
  database: CommerceDatabase,
  relation: DerivedRelationRows,
  desired: readonly (readonly CommerceSqlValue[])[],
): void {
  const keyIndexes = relation.keyColumns.map((column) => {
    const index = relation.columns.indexOf(column);
    if (index === -1)
      throw new Error(`${relation.table} key column ${column} is not listed`);
    return index;
  });
  const keyOf = (row: readonly CommerceSqlValue[]): string =>
    JSON.stringify(keyIndexes.map((index) => row[index] ?? null));
  const pending = new Map<string, readonly CommerceSqlValue[]>();
  for (const row of desired) pending.set(keyOf(row), row);
  const columnList = relation.columns.join(", ");
  const existing = database
    .prepare(
      `SELECT ${columnList} FROM ${relation.table} WHERE ${relation.ownerPredicate}`,
    )
    .all<Readonly<Record<string, CommerceSqlValue>>>(
      ...relation.ownerBindings,
    );
  const deleteRow = database.prepare(
    `DELETE FROM ${relation.table} WHERE ${relation.keyColumns
      .map((column) => `${column} = ?`)
      .join(" AND ")}`,
  );
  for (const record of existing) {
    const row = relation.columns.map((column) => record[column] ?? null);
    const key = keyOf(row);
    const wanted = pending.get(key);
    if (
      wanted !== undefined &&
      row.every((value, index) => value === (wanted[index] ?? null))
    ) {
      pending.delete(key);
      continue;
    }
    deleteRow.run(...keyIndexes.map((index) => row[index] ?? null));
  }
  if (pending.size === 0) return;
  const insertRow = database.prepare(
    `INSERT INTO ${relation.table} (${columnList})
     VALUES (${relation.columns.map(() => "?").join(", ")})`,
  );
  for (const row of pending.values()) insertRow.run(...row);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function explainUsesIndex(
  database: CommerceDatabase,
  sql: string,
  bindings: readonly CommerceSqlValue[],
  indexName: string,
): boolean {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all<Readonly<{ detail: string }>>(...bindings)
    .some((row) => row.detail.includes(indexName));
}
