import { DatabaseSync } from "node:sqlite";

import type {
  CommerceDatabase,
  CommerceSqlValue,
  CommerceStatement,
} from "./database.ts";

export class NodeCommerceDatabase implements CommerceDatabase {
  readonly #database: DatabaseSync;
  /** How many transactions are open; an inner one is a savepoint. */
  #depth = 0;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
  }

  exec(query: string): void {
    this.#database.exec(query);
  }

  prepare(query: string): CommerceStatement {
    const statement = this.#database.prepare(query);
    return {
      get: function get<Row extends object>(
        ...bindings: readonly CommerceSqlValue[]
      ): Row | undefined {
        return statement.get(...bindings) as Row | undefined;
      },
      all: function all<Row extends object>(
        ...bindings: readonly CommerceSqlValue[]
      ): readonly Row[] {
        return statement.all(...bindings) as unknown as readonly Row[];
      },
      run: function run(
        ...bindings: readonly CommerceSqlValue[]
      ): Readonly<{ changes: number }> {
        return { changes: Number(statement.run(...bindings).changes) };
      },
    };
  }

  transaction<Result>(operation: () => Result): Result {
    // workerd's transactionSync nests with savepoints; this does the same.
    const savepoint = `commerce_${this.#depth}`;
    this.#database.exec(
      this.#depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`,
    );
    this.#depth += 1;
    try {
      const result = operation();
      this.#depth -= 1;
      this.#database.exec(
        this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`,
      );
      return result;
    } catch (error) {
      this.#depth -= 1;
      this.#database.exec(
        this.#depth === 0
          ? "ROLLBACK"
          : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
