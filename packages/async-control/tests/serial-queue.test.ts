import { describe, expect, it } from "vitest";

import {
  createContinueSerialQueue,
  createFailStopSerialQueue,
  createKeyedContinueSerialQueue,
} from "../src/serial-queue";

describe("serial queues", serialQueueSuite);

function serialQueueSuite(): void {
  it("stops a fail-stop queue at its first failure", failStopTest);
  it("continues a continue queue after failure", continueAfterFailureTest);
  it(
    "serializes one key, overlaps different keys, and releases tails",
    keyedQueueTest,
  );
  it(
    "does not let a predecessor release a replacement tail",
    keyedTailReplacementTest,
  );
  it("rejects enqueue after close", closedQueueTest);
}

async function failStopTest(): Promise<void> {
  const queue = createFailStopSerialQueue();
  const calls: string[] = [];
  const failure = new Error("append failed");
  const first = queue.enqueue(
    recordFailure.bind(null, calls, "first", failure),
  );
  const second = queue.enqueue(recordSuccess.bind(null, calls, "second"));

  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
  await expect(queue.drain()).rejects.toBe(failure);
  expect(calls).toEqual(["first"]);
}

async function continueAfterFailureTest(): Promise<void> {
  const queue = createContinueSerialQueue();
  const calls: string[] = [];
  const failure = new Error("task failed");
  const first = queue.enqueue(
    recordFailure.bind(null, calls, "first", failure),
  );
  const second = queue.enqueue(recordSuccess.bind(null, calls, "second"));

  await expect(first).rejects.toBe(failure);
  await expect(second).resolves.toBe("second");
  await expect(queue.drain()).resolves.toBeUndefined();
  expect(calls).toEqual(["first", "second"]);
}

async function keyedQueueTest(): Promise<void> {
  const queue = createKeyedContinueSerialQueue<string>();
  const firstGate = new Deferred<void>();
  const secondKeyGate = new Deferred<void>();
  const calls: string[] = [];

  const first = queue.enqueue(
    "same",
    gatedTask.bind(null, calls, "same-1", firstGate),
  );
  const second = queue.enqueue(
    "same",
    recordSuccess.bind(null, calls, "same-2"),
  );
  const other = queue.enqueue(
    "other",
    gatedTask.bind(null, calls, "other-1", secondKeyGate),
  );
  await Promise.resolve();

  expect(calls).toEqual(["same-1", "other-1"]);
  expect(queue.pendingKeyCount).toBe(2);
  firstGate.resolve();
  await expect(first).resolves.toBe("same-1");
  await expect(second).resolves.toBe("same-2");
  expect(queue.pendingKeyCount).toBe(1);
  secondKeyGate.resolve();
  await expect(other).resolves.toBe("other-1");
  await queue.drain();
  expect(queue.pendingKeyCount).toBe(0);
  expect(calls).toEqual(["same-1", "other-1", "same-2"]);
}

async function keyedTailReplacementTest(): Promise<void> {
  const queue = createKeyedContinueSerialQueue<string>();
  const gate = new Deferred<void>();
  const state: SuccessorState = { successor: null };
  const first = queue.enqueue(
    "key",
    enqueueSuccessor.bind(null, queue, state, gate),
  );

  await Promise.resolve();
  expect(state.successor).not.toBeNull();
  expect(queue.pendingKeyCount).toBe(1);
  gate.resolve();
  await expect(first).resolves.toBe("first");
  if (state.successor === null) return;
  await expect(state.successor).resolves.toBe("successor");
  expect(queue.pendingKeyCount).toBe(0);
}

async function closedQueueTest(): Promise<void> {
  const queue = createContinueSerialQueue();
  await queue.close();
  expect(enqueueClosedQueue.bind(null, queue)).toThrow(
    "serial queue is closed",
  );
}

async function recordFailure(
  calls: string[],
  label: string,
  failure: Error,
): Promise<never> {
  calls.push(label);
  throw failure;
}

async function recordSuccess(calls: string[], label: string): Promise<string> {
  calls.push(label);
  return label;
}

async function gatedTask(
  calls: string[],
  label: string,
  gate: Deferred<void>,
): Promise<string> {
  calls.push(label);
  await gate.promise;
  return label;
}

function enqueueClosedQueue(
  queue: ReturnType<typeof createContinueSerialQueue>,
): void {
  void queue.enqueue(emptyTask);
}

async function emptyTask(): Promise<void> {}

type SuccessorState = { successor: Promise<string> | null };

async function enqueueSuccessor(
  queue: ReturnType<typeof createKeyedContinueSerialQueue<string>>,
  state: SuccessorState,
  gate: Deferred<void>,
): Promise<string> {
  state.successor = queue.enqueue("key", successorTask);
  await gate.promise;
  return "first";
}

async function successorTask(): Promise<string> {
  return "successor";
}

class Deferred<TValue = void> {
  readonly promise: Promise<TValue>;
  #resolve: ((value: TValue) => void) | null = null;

  constructor() {
    this.promise = new Promise<TValue>(this.capture.bind(this));
  }

  resolve(...values: TValue extends void ? [] : [TValue]): void {
    if (this.#resolve === null)
      throw new Error("deferred resolver unavailable");
    this.#resolve(values[0] as TValue);
  }

  private capture(resolve: (value: TValue) => void): void {
    this.#resolve = resolve;
  }
}
