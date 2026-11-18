export type TaskCancellationReason =
  | {
      readonly kind: "deadline_exceeded";
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "parent_cancelled";
    };

declare const cancellableTaskBrand: unique symbol;

export type CancellableTask<TValue, TCancellation> = {
  readonly [cancellableTaskBrand]: "cancellable_task";
  readonly completion: Promise<TValue>;
  cancel(reason: TaskCancellationReason): Promise<TCancellation>;
};

export type CancellableTaskInput<TValue, TCancellation> = {
  readonly completion: Promise<TValue>;
  readonly cancel: (reason: TaskCancellationReason) => Promise<TCancellation>;
};

type CancellationState<TCancellation> =
  | { readonly kind: "idle" }
  | {
      readonly kind: "settling";
      readonly settlement: Promise<TCancellation>;
    };

class OwnedCancellableTask<TValue, TCancellation> implements CancellableTask<
  TValue,
  TCancellation
> {
  declare readonly [cancellableTaskBrand]: "cancellable_task";
  readonly completion: Promise<TValue>;
  readonly #startCancellation: CancellableTaskInput<
    TValue,
    TCancellation
  >["cancel"];
  #cancellation: CancellationState<TCancellation> = { kind: "idle" };

  constructor(input: CancellableTaskInput<TValue, TCancellation>) {
    this.completion = input.completion;
    observeCompletion(this.completion);
    this.#startCancellation = input.cancel;
  }

  cancel(reason: TaskCancellationReason): Promise<TCancellation> {
    const cancellation = this.#cancellation;
    switch (cancellation.kind) {
      case "idle": {
        const deferred = new PromiseSettlement<TCancellation>();
        this.#cancellation = { kind: "settling", settlement: deferred.promise };
        const settlement = startCancellation(this.#startCancellation, reason);
        settleCancellation(deferred, settlement);
        return deferred.promise;
      }
      case "settling":
        return cancellation.settlement;
      default:
        return assertNever(cancellation);
    }
  }
}

class PromiseSettlement<TValue> {
  readonly promise: Promise<TValue>;
  #resolve: ((value: TValue | PromiseLike<TValue>) => void) | null = null;
  #reject: ((reason: unknown) => void) | null = null;

  constructor() {
    this.promise = new Promise<TValue>(this.capture.bind(this));
    observePromise(this.promise);
  }

  resolve(value: TValue): void {
    if (this.#resolve === null)
      throw new Error("promise settlement resolver unavailable");
    this.#resolve(value);
  }

  reject(cause: unknown): void {
    if (this.#reject === null)
      throw new Error("promise settlement rejector unavailable");
    this.#reject(cause);
  }

  private capture(
    resolve: (value: TValue | PromiseLike<TValue>) => void,
    reject: (reason: unknown) => void,
  ): void {
    this.#resolve = resolve;
    this.#reject = reject;
  }
}

function startCancellation<TCancellation>(
  cancel: (reason: TaskCancellationReason) => Promise<TCancellation>,
  reason: TaskCancellationReason,
): Promise<TCancellation> {
  try {
    return Promise.resolve(cancel(reason));
  } catch (cause) {
    return Promise.reject(cause);
  }
}

function settleCancellation<TCancellation>(
  deferred: PromiseSettlement<TCancellation>,
  settlement: Promise<TCancellation>,
): void {
  void settlement.then(
    deferred.resolve.bind(deferred),
    deferred.reject.bind(deferred),
  );
}

function observeCompletion<TValue>(completion: Promise<TValue>): void {
  observePromise(completion);
}

function observePromise<TValue>(promise: Promise<TValue>): void {
  void promise.then(ignorePromiseValue, ignorePromiseDefect);
}

function ignorePromiseValue<TValue>(_value: TValue): void {}

function ignorePromiseDefect(_cause: unknown): void {}

function assertNever(value: never): never {
  throw new Error(`unexpected cancellation state: ${String(value)}`);
}

export function createCancellableTask<TValue, TCancellation>(
  input: CancellableTaskInput<TValue, TCancellation>,
): CancellableTask<TValue, TCancellation> {
  return new OwnedCancellableTask(input);
}
