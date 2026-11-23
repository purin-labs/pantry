type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

type ObservedCursor = {
  readonly cursor: Cursor;
  readonly initialRowsRead: number;
  readonly initialRowsWritten: number;
};

type DatabaseSize =
  | { readonly kind: "available"; readonly bytes: number }
  | { readonly kind: "unavailable" };

export type SqliteObservationSnapshot = {
  readonly kind: "observed_at_boundary" | "incomplete";
  readonly calls: number;
  readonly retainedCursors: number;
  readonly failedCalls: number;
  readonly omittedCursors: number;
  readonly unreadableCounters: number;
  readonly initialRowsRead: number;
  readonly initialRowsWritten: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly databaseSize: {
    readonly initial: DatabaseSize;
    readonly current: DatabaseSize;
  };
};

/** Bounded experiment recorder. It never consumes or replaces a native cursor. */
export class SqliteObservation {
  private readonly cursors: ObservedCursor[] = [];
  private calls = 0;
  private failedCalls = 0;
  private omittedCursors = 0;
  private readonly initialDatabaseSize: DatabaseSize;

  constructor(
    private readonly nativeExec: SqlStorage["exec"],
    private readonly storage: SqlStorage,
  ) {
    this.initialDatabaseSize = readDatabaseSize(storage);
  }

  exec<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<Row> {
    this.calls += 1;
    let cursor: SqlStorageCursor<Row>;
    try {
      cursor = this.nativeExec<Row>(query, ...bindings);
    } catch (error) {
      this.failedCalls += 1;
      throw error;
    }
    // Retaining cursors has an observer cost. Bound it and report omissions.
    if (this.cursors.length < 4_096) {
      this.cursors.push({
        cursor,
        initialRowsRead: cursor.rowsRead,
        initialRowsWritten: cursor.rowsWritten,
      });
    } else {
      this.omittedCursors += 1;
    }
    return cursor;
  }

  snapshot(): SqliteObservationSnapshot {
    let initialRowsRead = 0;
    let initialRowsWritten = 0;
    let rowsRead = 0;
    let rowsWritten = 0;
    let unreadableCounters = 0;
    for (const observed of this.cursors) {
      initialRowsRead += observed.initialRowsRead;
      initialRowsWritten += observed.initialRowsWritten;
      try {
        rowsRead += observed.cursor.rowsRead;
        rowsWritten += observed.cursor.rowsWritten;
      } catch {
        unreadableCounters += 1;
      }
    }
    const currentDatabaseSize = readDatabaseSize(this.storage);
    const incomplete =
      this.failedCalls > 0 ||
      this.omittedCursors > 0 ||
      unreadableCounters > 0 ||
      this.initialDatabaseSize.kind === "unavailable" ||
      currentDatabaseSize.kind === "unavailable";
    return {
      kind: incomplete ? "incomplete" : "observed_at_boundary",
      calls: this.calls,
      retainedCursors: this.cursors.length,
      failedCalls: this.failedCalls,
      omittedCursors: this.omittedCursors,
      unreadableCounters,
      initialRowsRead,
      initialRowsWritten,
      rowsRead,
      rowsWritten,
      databaseSize: {
        initial: this.initialDatabaseSize,
        current: currentDatabaseSize,
      },
    };
  }
}

function readDatabaseSize(storage: SqlStorage): DatabaseSize {
  try {
    const bytes = storage.databaseSize;
    if (Number.isSafeInteger(bytes) && bytes >= 0)
      return { kind: "available", bytes };
  } catch {
    // An unavailable diagnostic must not change the application's outcome.
  }
  return { kind: "unavailable" };
}
