type FailStopSerialQueue = {
  readonly kind: "fail_stop";
  enqueue<TValue>(task: () => Promise<TValue>): Promise<TValue>;
  drain(): Promise<void>;
  close(): Promise<void>;
};

type ContinueSerialQueue = {
  readonly kind: "continue_after_failure";
  enqueue<TValue>(task: () => Promise<TValue>): Promise<TValue>;
  drain(): Promise<void>;
  close(): Promise<void>;
};

type KeyedContinueSerialQueue<TKey> = {
  readonly kind: "keyed_continue_after_failure";
  enqueue<TValue>(key: TKey, task: () => Promise<TValue>): Promise<TValue>;
  drain(): Promise<void>;
  close(): Promise<void>;
  readonly pendingKeyCount: number;
};

type QueueLifecycle = { readonly kind: "open" } | { readonly kind: "closed" };

type FailStopTail =
  | { readonly kind: "ready" }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
    };

type KeyedTail = {
  readonly completion: Promise<void>;
};

class OwnedKeyedTail<TKey> implements KeyedTail {
  readonly completion: Promise<void>;

  constructor(
    tails: Map<TKey, KeyedTail>,
    key: TKey,
    operation: Promise<unknown>,
  ) {
    this.completion = operation.then(
      releaseKeyedTail.bind(null, tails, key, this),
      releaseKeyedTail.bind(null, tails, key, this),
    );
  }
}

class FailStopSerialQueueImpl implements FailStopSerialQueue {
  readonly kind = "fail_stop" as const;
  #lifecycle: QueueLifecycle = { kind: "open" };
  #tail: Promise<FailStopTail> = Promise.resolve({ kind: "ready" });

  enqueue<TValue>(task: () => Promise<TValue>): Promise<TValue> {
    requireOpenQueue(this.#lifecycle);
    const execution = new FailStopExecution(task);
    const operation = this.#tail.then(execution.run.bind(execution));
    this.#tail = operation.then(successfulFailStopTail, failedFailStopTail);
    return operation;
  }

  async drain(): Promise<void> {
    const tail = await this.#tail;
    if (tail.kind === "failed") throw tail.cause;
  }

  close(): Promise<void> {
    this.#lifecycle = { kind: "closed" };
    return this.drain();
  }
}

class ContinueSerialQueueImpl implements ContinueSerialQueue {
  readonly kind = "continue_after_failure" as const;
  #lifecycle: QueueLifecycle = { kind: "open" };
  #tail: Promise<void> = Promise.resolve();

  enqueue<TValue>(task: () => Promise<TValue>): Promise<TValue> {
    requireOpenQueue(this.#lifecycle);
    const operation = this.#tail.then(task);
    this.#tail = operation.then(settledSerialTask, settledSerialTask);
    return operation;
  }

  drain(): Promise<void> {
    return this.#tail;
  }

  close(): Promise<void> {
    this.#lifecycle = { kind: "closed" };
    return this.drain();
  }
}

class KeyedContinueSerialQueueImpl<
  TKey,
> implements KeyedContinueSerialQueue<TKey> {
  readonly kind = "keyed_continue_after_failure" as const;
  #lifecycle: QueueLifecycle = { kind: "open" };
  readonly #tails = new Map<TKey, KeyedTail>();

  get pendingKeyCount(): number {
    return this.#tails.size;
  }

  enqueue<TValue>(key: TKey, task: () => Promise<TValue>): Promise<TValue> {
    requireOpenQueue(this.#lifecycle);
    const previous = this.#tails.get(key)?.completion ?? Promise.resolve();
    const operation = previous.then(task);
    const tail = new OwnedKeyedTail(this.#tails, key, operation);
    this.#tails.set(key, tail);
    return operation;
  }

  async drain(): Promise<void> {
    await Promise.all(Array.from(this.#tails.values(), keyedTailCompletion));
  }

  close(): Promise<void> {
    this.#lifecycle = { kind: "closed" };
    return this.drain();
  }
}

class FailStopExecution<TValue> {
  constructor(private readonly task: () => Promise<TValue>) {}

  async run(previous: FailStopTail): Promise<TValue> {
    if (previous.kind === "failed") throw previous.cause;
    return this.task();
  }
}

export function createFailStopSerialQueue(): FailStopSerialQueue {
  return new FailStopSerialQueueImpl();
}

export function createContinueSerialQueue(): ContinueSerialQueue {
  return new ContinueSerialQueueImpl();
}

export function createKeyedContinueSerialQueue<
  TKey,
>(): KeyedContinueSerialQueue<TKey> {
  return new KeyedContinueSerialQueueImpl<TKey>();
}

function requireOpenQueue(lifecycle: QueueLifecycle): void {
  if (lifecycle.kind === "closed") throw new Error("serial queue is closed");
}

function successfulFailStopTail(): FailStopTail {
  return { kind: "ready" };
}

function failedFailStopTail(cause: unknown): FailStopTail {
  return { kind: "failed", cause };
}

function settledSerialTask(): void {}

function releaseKeyedTail<TKey>(
  tails: Map<TKey, KeyedTail>,
  key: TKey,
  settledTail: KeyedTail,
): void {
  if (tails.get(key) === settledTail) tails.delete(key);
}

function keyedTailCompletion(tail: KeyedTail): Promise<void> {
  return tail.completion;
}
