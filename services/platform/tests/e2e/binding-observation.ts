type BindingKind = "kv" | "r2" | "queue";

type OperationCounts = {
  calls: number;
  pending: number;
  fulfilled: number;
  rejected: number;
  untrackedResults: number;
  knownRequestedItems: number;
  unknownItemCalls: number;
  knownObjectBytes: number;
  knownObjectResults: number;
  nullObjectResults: number;
  unknownObjectSizeResults: number;
};

export type BindingObservationSnapshot = {
  readonly kind: "settled_calls" | "incomplete";
  readonly operations: Readonly<Record<string, Readonly<OperationCounts>>>;
};

/** Experiment-only calls and R2 object sizes. These are not billable units. */
export class BindingObservation {
  private readonly operations = new Map<string, OperationCounts>();

  kv(binding: KVNamespace): KVNamespace {
    return new Proxy<KVNamespace>(binding, {
      get: this.property.bind(this, "kv"),
    });
  }

  r2(binding: R2Bucket): R2Bucket {
    return new Proxy<R2Bucket>(binding, {
      get: this.property.bind(this, "r2"),
    });
  }

  queue<Body>(binding: Queue<Body>): Queue<Body> {
    return new Proxy<Queue<Body>>(binding, {
      get: this.property.bind(this, "queue"),
    });
  }

  snapshot(): BindingObservationSnapshot {
    const operations: Record<string, OperationCounts> = {};
    let incomplete = false;
    for (const [name, counts] of this.operations) {
      operations[name] = { ...counts };
      if (
        counts.pending > 0 ||
        counts.rejected > 0 ||
        counts.untrackedResults > 0 ||
        counts.unknownItemCalls > 0 ||
        counts.unknownObjectSizeResults > 0
      ) {
        incomplete = true;
      }
    }
    return { kind: incomplete ? "incomplete" : "settled_calls", operations };
  }

  private property(kind: BindingKind, target: object, key: string | symbol) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    const name = `${kind}.${String(key)}`;
    return this.invoke.bind(this, name, target, value);
  }

  private invoke(
    name: string,
    target: object,
    method: Function,
    ...args: unknown[]
  ): unknown {
    let counts = this.operations.get(name);
    if (counts === undefined) {
      counts = {
        calls: 0,
        pending: 0,
        fulfilled: 0,
        rejected: 0,
        untrackedResults: 0,
        knownRequestedItems: 0,
        unknownItemCalls: 0,
        knownObjectBytes: 0,
        knownObjectResults: 0,
        nullObjectResults: 0,
        unknownObjectSizeResults: 0,
      };
      this.operations.set(name, counts);
    }
    counts.calls += 1;
    const items = requestedItems(name, args[0]);
    if (items === null) counts.unknownItemCalls += 1;
    else counts.knownRequestedItems += items;
    let result: unknown;
    try {
      result = Reflect.apply(method, target, args);
    } catch (error) {
      counts.rejected += 1;
      throw error;
    }
    // Forward synchronous APIs unchanged. Multipart child methods are untracked.
    if (!(result instanceof Promise)) {
      counts.untrackedResults += 1;
      return result;
    }
    counts.pending += 1;
    return result.then(
      fulfilled.bind(null, name, counts),
      rejected.bind(null, counts),
    );
  }
}

function requestedItems(name: string, first: unknown): number | null {
  switch (name) {
    case "kv.get":
    case "kv.getWithMetadata":
    case "r2.delete":
      return Array.isArray(first) ? first.length : 1;
    case "kv.put":
    case "kv.delete":
    case "r2.get":
    case "r2.head":
    case "r2.put":
    case "queue.send":
      return 1;
    case "queue.sendBatch":
      // Never advance a one-shot iterable to count messages.
      return Array.isArray(first) ? first.length : null;
    case "kv.list":
    case "r2.list":
    case "queue.metrics":
      return 0;
    default:
      return null;
  }
}

function fulfilled(
  name: string,
  counts: OperationCounts,
  value: unknown,
): unknown {
  counts.pending -= 1;
  counts.fulfilled += 1;
  observeObjectSize(name, counts, value);
  return value;
}

function observeObjectSize(
  name: string,
  counts: OperationCounts,
  value: unknown,
): void {
  if (name !== "r2.put" && name !== "r2.get" && name !== "r2.head") return;
  if (value === null) {
    counts.nullObjectResults += 1;
    return;
  }
  // R2 reports full object size, including for range GETs. Never read the body.
  try {
    if (typeof value === "object" && "size" in value) {
      const bytes = value.size;
      if (
        typeof bytes === "number" &&
        Number.isSafeInteger(bytes) &&
        bytes >= 0
      ) {
        counts.knownObjectBytes += bytes;
        counts.knownObjectResults += 1;
        return;
      }
    }
  } catch {
    // Observation must preserve the native result even if metadata is unreadable.
  }
  counts.unknownObjectSizeResults += 1;
}

function rejected(counts: OperationCounts, error: unknown): never {
  counts.pending -= 1;
  counts.rejected += 1;
  throw error;
}
