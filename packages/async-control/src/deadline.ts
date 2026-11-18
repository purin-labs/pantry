import type {
  CancellableTask,
  TaskCancellationReason,
} from "./cancellable-task.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export type DeadlineOutcome<TValue, TCancellation> =
  | {
      readonly kind: "completed";
      readonly value: TValue;
    }
  | {
      readonly kind: "deadline_exceeded";
      readonly cancellation: TCancellation;
    };

type TaskDeadlineInput<TValue, TCancellation> = {
  readonly timeoutMs: number;
  readonly start: () => CancellableTask<TValue, TCancellation>;
};

type DeadlineReached = { readonly kind: "deadline_reached" };

type CancellationSettlement<TCancellation> =
  | {
      readonly kind: "completed";
      readonly value: TCancellation;
    }
  | {
      readonly kind: "defect";
      readonly cause: unknown;
    };

type ObservedTask<TValue> =
  | {
      readonly kind: "completed";
      readonly value: TValue;
    }
  | {
      readonly kind: "completion_defect";
      readonly cause: unknown;
    }
  | DeadlineReached;

type CompletionObservation<TValue> = {
  readonly settlement: Promise<ObservedTask<TValue>>;
};

class OwnedCompletionObservation<
  TValue,
> implements CompletionObservation<TValue> {
  readonly settlement: Promise<ObservedTask<TValue>>;

  constructor(completion: Promise<TValue>) {
    this.settlement = completion.then(completedTask, completionDefect);
  }
}

type DeadlineTimer = {
  readonly reached: Promise<DeadlineReached>;
  clear(): void;
};

type MutableDeadlineTimer = {
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export async function runTaskBeforeDeadline<TValue, TCancellation>(
  input: TaskDeadlineInput<TValue, TCancellation>,
): Promise<DeadlineOutcome<TValue, TCancellation>> {
  requirePositiveTimeout(input.timeoutMs);
  const task = input.start();
  const completion = observeCompletion(task.completion);
  const deadline = createDeadlineTimer(input.timeoutMs);
  try {
    const observed = await Promise.race<ObservedTask<TValue>>([
      completion.settlement,
      deadline.reached,
    ]);
    if (observed.kind === "completed") return observed;
    if (observed.kind === "completion_defect") throw observed.cause;
    const reason: TaskCancellationReason = {
      kind: "deadline_exceeded",
      timeoutMs: input.timeoutMs,
    };
    const cancellation = await cancelAfterDeadline(task, completion, reason);
    return { kind: "deadline_exceeded", cancellation };
  } finally {
    deadline.clear();
  }
}

async function cancelAfterDeadline<TValue, TCancellation>(
  task: CancellableTask<TValue, TCancellation>,
  completion: CompletionObservation<TValue>,
  reason: TaskCancellationReason,
): Promise<TCancellation> {
  const cancellation = observeCancellation(startTaskCancellation(task, reason));
  const settled = await completion.settlement;
  const cancellationSettlement = await cancellation;
  if (settled.kind === "completion_defect") {
    if (cancellationSettlement.kind === "defect") {
      throw combineDeadlineDefects(settled.cause, cancellationSettlement.cause);
    }
    throw settled.cause;
  }
  if (cancellationSettlement.kind === "defect") {
    throw cancellationSettlement.cause;
  }
  return cancellationSettlement.value;
}

function startTaskCancellation<TValue, TCancellation>(
  task: CancellableTask<TValue, TCancellation>,
  reason: TaskCancellationReason,
): Promise<TCancellation> {
  try {
    return Promise.resolve(task.cancel(reason));
  } catch (cause) {
    return Promise.reject(cause);
  }
}

function observeCancellation<TCancellation>(
  cancellation: Promise<TCancellation>,
): Promise<CancellationSettlement<TCancellation>> {
  return cancellation.then(completedCancellation, defectiveCancellation);
}

function completedCancellation<TCancellation>(
  value: TCancellation,
): CancellationSettlement<TCancellation> {
  return { kind: "completed", value };
}

function defectiveCancellation(cause: unknown): CancellationSettlement<never> {
  return { kind: "defect", cause };
}

function combineDeadlineDefects(
  completionCause: unknown,
  cancellationCause: unknown,
): unknown {
  if (completionCause === cancellationCause) return completionCause;
  return new AggregateError(
    [completionCause, cancellationCause],
    "task completion and deadline cancellation both failed",
  );
}

function requirePositiveTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}`,
    );
  }
}

function completedTask<TValue>(value: TValue): ObservedTask<TValue> {
  return { kind: "completed", value };
}

function completionDefect(cause: unknown): ObservedTask<never> {
  return { kind: "completion_defect", cause };
}

function observeCompletion<TValue>(
  completion: Promise<TValue>,
): CompletionObservation<TValue> {
  return new OwnedCompletionObservation(completion);
}

function createDeadlineTimer(timeoutMs: number): DeadlineTimer {
  const state: MutableDeadlineTimer = { timeoutMs, timer: null };
  const reached = new Promise<DeadlineReached>(
    startDeadlineTimer.bind(null, state),
  );
  return {
    reached,
    clear: clearDeadlineTimer.bind(null, state),
  };
}

function startDeadlineTimer(
  state: MutableDeadlineTimer,
  resolve: (value: DeadlineReached) => void,
): void {
  state.timer = setTimeout(
    resolveDeadline.bind(null, resolve),
    state.timeoutMs,
  );
}

function resolveDeadline(resolve: (value: DeadlineReached) => void): void {
  resolve({ kind: "deadline_reached" });
}

function clearDeadlineTimer(state: MutableDeadlineTimer): void {
  if (state.timer === null) return;
  clearTimeout(state.timer);
  state.timer = null;
}
