import type { CancellableTask } from "../src/cancellable-task";
import { runTaskBeforeDeadline, type DeadlineOutcome } from "../src/deadline";

declare const task: CancellableTask<string, "cancelled">;

void runTaskBeforeDeadline({ timeoutMs: 1, start: startTask });

// @ts-expect-error A bare promise has no owned cancellation contract.
void runTaskBeforeDeadline({ timeoutMs: 1, start: startBarePromise });

// @ts-expect-error Task construction must return its cancellation handle synchronously.
void runTaskBeforeDeadline({ timeoutMs: 1, start: startTaskAsynchronously });

// @ts-expect-error Task construction must provide cancellation behavior.
void runTaskBeforeDeadline({ timeoutMs: 1, start: startWithoutCancellation });

function startTask(): CancellableTask<string, "cancelled"> {
  return task;
}

function startBarePromise(): Promise<string> {
  return Promise.resolve("unowned");
}

async function startTaskAsynchronously(): Promise<
  CancellableTask<string, "cancelled">
> {
  return task;
}

function startWithoutCancellation(): { readonly completion: Promise<string> } {
  return { completion: Promise.resolve("unowned") };
}

function invalidOutcomeAccess(
  outcome: DeadlineOutcome<string, "cancelled">,
): void {
  if (outcome.kind === "completed") {
    // @ts-expect-error Completed outcomes do not carry cancellation state.
    void outcome.cancellation;
  }
}

void invalidOutcomeAccess;

// @ts-expect-error Cancellable tasks must come from the owning constructor.
const invalidCancellableTask: CancellableTask<string, "cancelled"> = {
  completion: Promise.resolve("value"),
  cancel: async () => "cancelled",
};

void invalidCancellableTask;
