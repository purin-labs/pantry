import type { MachineStore } from "@purin-labs/std/state-machine";

type SqlValue = string | number | null;

/**
 * One move of a machine whose state lives in a D1 table with a `revision`
 * column (Refactor 15, S2). The statement is a compare-and-set: it changes
 * the row only while it still has the state and the revision that the caller
 * read. It is returned unrun, so the caller can put it in a `batch` with the
 * other rows of the same move. Read the result with `d1TransitionApplied`:
 * when no row changed, the caller reads the row again and decides; it never
 * writes again blindly.
 *
 * `where` holds the row's key columns; `set` holds the other columns that
 * the move writes. The helper writes the state, the revision and
 * `updated_at` itself.
 */
export function prepareD1Transition(
  database: Readonly<{ prepare(query: string): D1PreparedStatement }>,
  store: MachineStore,
  input: Readonly<{
    where: Readonly<Record<string, SqlValue>>;
    from: Readonly<{ state: string; revision: number }>;
    to: string;
    set?: Readonly<Record<string, SqlValue>>;
    updatedAt: number;
  }>,
): D1PreparedStatement {
  const set = Object.entries(input.set ?? {});
  const where = Object.entries(input.where);
  const assignments = [
    `${store.column} = ?`,
    ...set.map(([column]) => `${column} = ?`),
    "revision = revision + 1",
    "updated_at = ?",
  ];
  const guards = [
    ...where.map(([column]) => `${column} = ?`),
    `${store.column} = ?`,
    "revision = ?",
  ];
  return database
    .prepare(
      `UPDATE ${store.table} SET ${assignments.join(", ")} WHERE ${guards.join(" AND ")}`,
    )
    .bind(
      input.to,
      ...set.map(([, value]) => value),
      input.updatedAt,
      ...where.map(([, value]) => value),
      input.from.state,
      input.from.revision,
    );
}

/** True when the compare-and-set of one move changed its row. */
export function d1TransitionApplied(result: D1Result): boolean {
  return result.meta.changes === 1;
}
