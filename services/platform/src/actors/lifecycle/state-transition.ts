import type { MachineStore } from "@seams/std/state-machine";

const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/u;

/**
 * Writes one move of a machine whose state lives in Actor SQLite (Refactor
 * 15, S2). The write is a compare-and-set: it changes the row only while the
 * stored state is still `from`. It returns false when no row changed, so the
 * caller reads the row again and decides; it never writes again blindly.
 *
 * `value` is the whole new column value, for example the new JSON payload.
 * `match` adds conditions to the compare-and-set: the rest of a compound key,
 * or the claim that the caller holds. A null in `match` matches a null.
 * `set` writes more columns of the same move in the same statement.
 */
export function writeActorTransition(
  sql: SqlStorage,
  store: MachineStore,
  input: Readonly<{
    key: string | number;
    from: string;
    value: string | number;
    match?: Readonly<Record<string, SqlStorageValue>>;
    set?: Readonly<Record<string, SqlStorageValue>>;
  }>,
): boolean {
  const stored =
    store.path === undefined
      ? store.column
      : `json_extract(${store.column}, '${store.path}')`;
  const set = Object.entries(input.set ?? {});
  const match = Object.entries(input.match ?? {});
  for (const [column] of [...set, ...match])
    if (!COLUMN_NAME.test(column))
      throw new Error(`state_transition_column_invalid:${column}`);
  const updated = sql.exec(
    `UPDATE ${store.table}
        SET ${[store.column, ...set.map(([column]) => column)]
          .map((column) => `${column} = ?`)
          .join(", ")}
      WHERE ${store.key} = ? AND ${stored} = ?${match
        .map(([column]) => ` AND ${column} IS ?`)
        .join("")}`,
    input.value,
    ...set.map(([, value]) => value),
    input.key,
    input.from,
    ...match.map(([, value]) => value),
  );
  // The key matches one row at most. SQLite also counts each index entry that
  // the write changes, so a table with an index on the state counts more.
  return updated.rowsWritten > 0;
}
