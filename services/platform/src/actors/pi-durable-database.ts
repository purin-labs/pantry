import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

function ignore(): void {}

function invokeOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

class SqlExecutor implements SqliteExecutor {
  active = true;

  constructor(readonly sql: SqlStorage) {}

  query(statement: string, bindings: SqliteValue[]) {
    if (!this.active) throw new Error("Expired SQL transaction handle");
    try {
      return this.sql.exec(statement, ...bindings.map(sqlValue));
    } catch (error) {
      throw new Error(
        `SQL failed (${bindings.length} bindings): ${statement}`,
        {
          cause: error,
        },
      );
    }
  }

  async exec(statement: string) {
    this.query(statement, []);
  }

  async run(statement: string, ...bindings: SqliteValue[]) {
    this.query(statement, bindings);
  }

  async runCounted(statement: string, ...bindings: SqliteValue[]) {
    this.query(statement, bindings);
    // The cursor's `rowsWritten` also counts index writes.
    const row = this.query("SELECT changes() AS changes", []).one();
    return Number(row.changes);
  }

  async get<T extends object>(
    statement: string,
    ...bindings: SqliteValue[]
  ): Promise<T | undefined> {
    return this.query(statement, bindings).toArray()[0] as T | undefined;
  }

  async all<T extends object>(
    statement: string,
    ...bindings: SqliteValue[]
  ): Promise<T[]> {
    return this.query(statement, bindings).toArray() as T[];
  }
}

export class ActorSqliteDatabase implements SqliteDatabase {
  tail = Promise.resolve();

  readonly executor: SqlExecutor;

  constructor(readonly storage: DurableObjectStorage) {
    this.executor = new SqlExecutor(storage.sql);
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then((invokeOperation<T>).bind(null, operation));
    this.tail = result.then(ignore, ignore);
    return result;
  }

  exec(statement: string) {
    return this.enqueue(this.executor.exec.bind(this.executor, statement));
  }

  run(statement: string, ...bindings: SqliteValue[]) {
    return this.enqueue(
      this.executor.run.bind(this.executor, statement, ...bindings),
    );
  }

  runCounted(statement: string, ...bindings: SqliteValue[]) {
    return this.enqueue(
      this.executor.runCounted.bind(this.executor, statement, ...bindings),
    );
  }

  get<T extends object>(
    statement: string,
    ...bindings: SqliteValue[]
  ): Promise<T | undefined> {
    return this.enqueue(
      (this.executor.get<T>).bind(this.executor, statement, ...bindings),
    );
  }

  all<T extends object>(
    statement: string,
    ...bindings: SqliteValue[]
  ): Promise<T[]> {
    return this.enqueue(
      (this.executor.all<T>).bind(this.executor, statement, ...bindings),
    );
  }

  transaction<T>(
    callback: (executor: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    return this.enqueue((this.transact<T>).bind(this, callback));
  }

  transact<T>(callback: (executor: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.storage.transaction((this.invoke<T>).bind(this, callback));
  }

  async invoke<T>(
    callback: (executor: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    const executor = new SqlExecutor(this.storage.sql);
    try {
      return await callback(executor);
    } finally {
      executor.active = false;
    }
  }

  close() {
    return this.tail;
  }
}

// The library owns row decoding. These generic casts bridge its SQL interface
// to Cloudflare's untyped rows; they do not create Pantry domain objects.
function sqlValue(value: SqliteValue): SqlStorageValue {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("Unsafe SQLite integer");
    return number;
  }
  if (value instanceof Uint8Array) return value.slice().buffer;
  return value;
}
