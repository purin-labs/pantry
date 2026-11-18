import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCancellableTask,
  type CancellableTask,
  type TaskCancellationReason,
} from "../src/cancellable-task";
import { runTaskBeforeDeadline } from "../src/deadline";

describe("task deadline", taskDeadlineSuite);

function taskDeadlineSuite(): void {
  beforeEach(useFakeTimers);
  afterEach(useRealTimers);
  it("returns completed work without cancellation", completedTaskTest);
  it("waits for exactly one cancellation settlement", deadlineCancellationTest);
  it("preserves completion defects and clears the timer", completionDefectTest);
  it("preserves cancellation defects", cancellationDefectTest);
  it(
    "preserves simultaneous completion and cancellation defects",
    combinedDefectTest,
  );
  it(
    "memoizes a synchronous cancellation defect",
    synchronousCancellationDefectTest,
  );
  it(
    "memoizes cancellation during a re-entrant request",
    reentrantCancellationTest,
  );
  it("rejects invalid timeout values", invalidTimeoutTest);
  it("accepts the timer maximum and rejects overflow", timeoutOverflowTest);
}

function useFakeTimers(): void {
  vi.useFakeTimers();
}

function useRealTimers(): void {
  vi.useRealTimers();
}

async function completedTaskTest(): Promise<void> {
  const script = new DeadlineScript(Promise.resolve("done"));
  const result = await runTaskBeforeDeadline({
    timeoutMs: 100,
    start: script.start.bind(script),
  });
  expect(result).toEqual({ kind: "completed", value: "done" });
  expect(script.cancelCalls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

async function deadlineCancellationTest(): Promise<void> {
  const completion = new Deferred<string>();
  const cancellation = new Deferred<string>();
  const script = new DeadlineScript(completion.promise, cancellation.promise);
  const pending = runTaskBeforeDeadline({
    timeoutMs: 25,
    start: script.start.bind(script),
  });
  const observation = observeSettlement(pending);

  await vi.advanceTimersByTimeAsync(25);
  expect(script.cancelCalls).toBe(1);
  expect(observation.settled).toBe(false);
  cancellation.resolve("cancelled");
  completion.resolve("settled after cancellation");

  await expect(pending).resolves.toEqual({
    kind: "deadline_exceeded",
    cancellation: "cancelled",
  });
  await script.task.cancel({ kind: "parent_cancelled" });
  expect(script.cancelCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
}

async function completionDefectTest(): Promise<void> {
  const failure = new Error("completion defect");
  const script = new DeadlineScript(Promise.reject(failure));
  await expect(
    runTaskBeforeDeadline({
      timeoutMs: 100,
      start: script.start.bind(script),
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
}

async function cancellationDefectTest(): Promise<void> {
  const completion = new Deferred<string>();
  const cancellation = new Deferred<string>();
  const failure = new Error("cancellation defect");
  const script = new DeadlineScript(completion.promise, cancellation.promise);
  const pending = runTaskBeforeDeadline({
    timeoutMs: 25,
    start: script.start.bind(script),
  });
  await vi.advanceTimersByTimeAsync(25);
  cancellation.reject(failure);
  await Promise.resolve();
  const observation = observeSettlement(pending);
  expect(observation.settled).toBe(false);
  completion.resolve("settled after cancellation defect");
  await expect(pending).rejects.toBe(failure);
  expect(script.cancelCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
}

async function combinedDefectTest(): Promise<void> {
  const completion = new Deferred<string>();
  const cancellation = new Deferred<string>();
  const completionFailure = new Error("completion defect");
  const cancellationFailure = new Error("cancellation defect");
  const script = new DeadlineScript(completion.promise, cancellation.promise);
  const pending = runTaskBeforeDeadline({
    timeoutMs: 25,
    start: script.start.bind(script),
  });

  await vi.advanceTimersByTimeAsync(25);
  completion.reject(completionFailure);
  cancellation.reject(cancellationFailure);

  const defect = await captureDefect(pending);
  expect(defect).toBeInstanceOf(AggregateError);
  expect((defect as AggregateError).errors).toEqual([
    completionFailure,
    cancellationFailure,
  ]);
  expect(vi.getTimerCount()).toBe(0);
}

async function synchronousCancellationDefectTest(): Promise<void> {
  const failure = new Error("synchronous cancellation defect");
  const state = { calls: 0, failure };
  const task = createCancellableTask({
    completion: new Deferred<string>().promise,
    cancel: throwSynchronousCancellation.bind(null, state),
  });
  const first = task.cancel({ kind: "deadline_exceeded", timeoutMs: 1 });
  const second = task.cancel({ kind: "parent_cancelled" });

  expect(second).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(state.calls).toBe(1);
}

async function reentrantCancellationTest(): Promise<void> {
  const state: ReentrantCancellationState = {
    task: null,
    calls: 0,
    nested: null,
  };
  state.task = createCancellableTask({
    completion: Promise.resolve("complete"),
    cancel: reentrantCancellation.bind(null, state),
  });

  const first = state.task.cancel({ kind: "deadline_exceeded", timeoutMs: 1 });

  expect(state.calls).toBe(1);
  expect(state.nested).toBe(first);
  await expect(first).resolves.toBe("cancelled");
}

async function invalidTimeoutTest(): Promise<void> {
  const script = new DeadlineScript(Promise.resolve("done"));
  await expect(
    runTaskBeforeDeadline({
      timeoutMs: 0,
      start: script.start.bind(script),
    }),
  ).rejects.toThrow(
    "timeoutMs must be a positive integer no greater than 2147483647",
  );
}

async function timeoutOverflowTest(): Promise<void> {
  const script = new DeadlineScript(Promise.resolve("done"));
  await expect(
    runTaskBeforeDeadline({
      timeoutMs: 2_147_483_647,
      start: script.start.bind(script),
    }),
  ).resolves.toEqual({ kind: "completed", value: "done" });
  await expect(
    runTaskBeforeDeadline({
      timeoutMs: 2_147_483_648,
      start: script.start.bind(script),
    }),
  ).rejects.toThrow(
    "timeoutMs must be a positive integer no greater than 2147483647",
  );
  expect(vi.getTimerCount()).toBe(0);
}

class DeadlineScript {
  readonly task: CancellableTask<string, string>;
  cancelCalls = 0;
  readonly #cancellation: Promise<string> | null;

  constructor(
    completion: Promise<string>,
    cancellation: Promise<string> | null = null,
  ) {
    this.#cancellation = cancellation;
    this.task = createCancellableTask({
      completion,
      cancel: this.cancel.bind(this),
    });
  }

  start(): CancellableTask<string, string> {
    return this.task;
  }

  cancel(_reason: TaskCancellationReason): Promise<string> {
    this.cancelCalls += 1;
    return this.#cancellation ?? Promise.resolve("cancelled");
  }
}

class Deferred<TValue> {
  readonly promise: Promise<TValue>;
  #resolve: ((value: TValue) => void) | null = null;
  #reject: ((reason: unknown) => void) | null = null;

  constructor() {
    this.promise = new Promise<TValue>(this.capture.bind(this));
  }

  resolve(value: TValue): void {
    if (this.#resolve === null)
      throw new Error("deferred resolver unavailable");
    this.#resolve(value);
  }

  reject(reason: unknown): void {
    if (this.#reject === null) throw new Error("deferred rejector unavailable");
    this.#reject(reason);
  }

  private capture(
    resolve: (value: TValue) => void,
    reject: (reason: unknown) => void,
  ): void {
    this.#resolve = resolve;
    this.#reject = reject;
  }
}

type SettlementObservation = { settled: boolean };

function observeSettlement<TValue>(
  promise: Promise<TValue>,
): SettlementObservation {
  const observation = { settled: false };
  void promise.then(
    markSettled.bind(null, observation),
    markSettled.bind(null, observation),
  );
  return observation;
}

function markSettled(observation: SettlementObservation): void {
  observation.settled = true;
}

async function captureDefect(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(unexpectedFulfillment, captureRejection);
}

function unexpectedFulfillment(): never {
  throw new Error("expected promise to reject");
}

function captureRejection(cause: unknown): unknown {
  return cause;
}

function throwSynchronousCancellation(
  state: { calls: number; readonly failure: Error },
  _reason: TaskCancellationReason,
): Promise<string> {
  state.calls += 1;
  throw state.failure;
}

type ReentrantCancellationState = {
  task: CancellableTask<string, string> | null;
  calls: number;
  nested: Promise<string> | null;
};

function reentrantCancellation(
  state: ReentrantCancellationState,
  _reason: TaskCancellationReason,
): Promise<string> {
  state.calls += 1;
  if (state.task !== null) {
    state.nested = state.task.cancel({ kind: "parent_cancelled" });
  }
  return Promise.resolve("cancelled");
}
