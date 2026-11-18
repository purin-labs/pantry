export type CommerceSqlValue = string | number | null;

export type CommerceRunResult = Readonly<{ changes: number }>;

/** A row from `SELECT COUNT(*) AS count`. */
export type CountRow = Readonly<{ count: number }>;

export interface CommerceStatement {
  get<Row extends object>(
    ...bindings: readonly CommerceSqlValue[]
  ): Row | undefined;
  all<Row extends object>(
    ...bindings: readonly CommerceSqlValue[]
  ): readonly Row[];
  run(...bindings: readonly CommerceSqlValue[]): CommerceRunResult;
}

export interface CommerceDatabase {
  exec(query: string): void;
  prepare(query: string): CommerceStatement;
  /**
   * Runs `operation` in a transaction. A transaction inside another one is a
   * savepoint: its throw rolls back only its own writes, and the outer
   * transaction still decides whether everything commits.
   */
  transaction<Result>(operation: () => Result): Result;
  close(): void;
}
