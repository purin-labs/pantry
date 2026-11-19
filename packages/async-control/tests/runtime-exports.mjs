import assert from "node:assert/strict";
import test from "node:test";

import { createCancellableTask } from "@purin-labs/async-control/cancellable-task";
import { runTaskBeforeDeadline } from "@purin-labs/async-control/deadline";
import { createContinueSerialQueue } from "@purin-labs/async-control/serial-queue";

test("compiled package subpaths load in Node", compiledExportsLoadTest);

async function compiledExportsLoadTest() {
  const task = createCancellableTask({
    completion: Promise.resolve("complete"),
    cancel: cancelTask,
  });
  const deadline = await runTaskBeforeDeadline({
    timeoutMs: 100,
    start: startTask.bind(null, task),
  });
  const queue = createContinueSerialQueue();
  const queued = await queue.enqueue(completeQueuedTask);

  assert.deepEqual(deadline, { kind: "completed", value: "complete" });
  assert.equal(queued, "queued");
  await queue.close();
}

async function cancelTask() {
  return "cancelled";
}

function startTask(task) {
  return task;
}

async function completeQueuedTask() {
  return "queued";
}
