import type {
  CommerceDatabase,
  CommerceSqlValue,
  CommerceStatement,
} from "./database.ts";

export class DurableObjectCommerceDatabase implements CommerceDatabase {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  transaction<Result>(operation: () => Result): Result {
    return this.#storage.transactionSync(operation);
  }

  exec(query: string): void {
    this.#sql.exec(query);
  }

  prepare(query: string): CommerceStatement {
    const sql = this.#sql;
    return {
      get: function get<Row extends object>(
        ...bindings: readonly CommerceSqlValue[]
      ): Row | undefined {
        return sql
          .exec<Record<string, SqlStorageValue>>(query, ...bindings)
          .toArray()[0] as Row | undefined;
      },
      all: function all<Row extends object>(
        ...bindings: readonly CommerceSqlValue[]
      ): readonly Row[] {
        return sql
          .exec<Record<string, SqlStorageValue>>(query, ...bindings)
          .toArray() as unknown as readonly Row[];
      },
      run: function run(
        ...bindings: readonly CommerceSqlValue[]
      ): Readonly<{ changes: number }> {
        sql.exec(query, ...bindings).toArray();
        const result = sql
          .exec<Readonly<{ changes: number }>>("SELECT changes() AS changes")
          .toArray()[0];
        if (
          result === undefined ||
          !Number.isSafeInteger(result.changes) ||
          result.changes < 0
        ) {
          throw new Error(
            "Durable Object SQL returned an invalid affected-row count",
          );
        }
        return { changes: result.changes };
      },
    };
  }

  close(): void {}
}
