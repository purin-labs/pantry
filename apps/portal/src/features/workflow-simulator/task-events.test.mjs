import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettings, sampleSettings } from "@purin-labs/bakery-model/bakery";
import {
  simulate,
  simulateSteps,
  resolveFinancierRun,
  taskAt,
  workerAt,
  workerTasks,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { operationTask, operationWait } from "@purin-labs/production-simulation/simulator/selection";

function settings(changes) {
  const result = parseSettings({ ...sampleSettings(), ...changes });
  assert.equal(result.kind, "valid");
  return result.settings;
}

test(
  "stepped execution and full simulation share ordered immutable event prefixes",
  checkStepping,
);

function checkStepping() {
  for (const variant of ["normal", "outage"]) {
    const input = settings({ workerCount: 2 });
    const execution = simulateSteps(resolveFinancierRun(input, variant));
    const observed = [];
    const snapshots = [];
    let previousTime = -1;
    let next = execution.next();
    while (!next.done) {
      const step = next.value;
      assert.ok(step.time > previousTime);
      previousTime = step.time;
      for (const event of step.events) assert.equal(event.time, step.time);
      observed.push(...step.events);
      snapshots.push({ step, copy: structuredClone(step) });
      next = execution.next();
    }
    assert.deepEqual(next.value, simulate(input, variant));
    assert.deepEqual(observed, next.value.taskEvents);
    for (const snapshot of snapshots)
      assert.deepEqual(snapshot.step, snapshot.copy);
  }
}

test(
  "task identities and named allocations survive rescheduling with exclusive workers",
  checkIdentity,
);

function checkIdentity() {
  const normal = simulate(settings({ workerCount: 2 }), "normal");
  const outage = simulate(normal.settings, "outage");
  const normalTasks = normal.intervals.filter(isTask);
  const outageTasks = outage.intervals.filter(isTask);
  assert.deepEqual(
    normalTasks.map(bakeryTaskId).sort(),
    outageTasks.map(bakeryTaskId).sort(),
  );
  assert.equal(new Set(normalTasks.map(bakeryTaskId)).size, normalTasks.length);
  assert.deepEqual(normal.resources.map(resourceIdentity), [
    ["human-1", "Baker 1"],
    ["human-2", "Baker 2"],
  ]);

  const allocated = [];
  for (const resource of normal.resources) {
    const tasks = workerTasks(normal, resource.id);
    assert.ok(tasks.length > 0);
    let end = 0;
    for (const task of tasks) {
      assert.equal(task.executor, resource.id);
      assert.ok(task.start >= end);
      end = task.end;
      allocated.push(task.id);
    }
    assert.deepEqual(workerAt(normal, resource, -1, false), resource.start);
  }
  assert.deepEqual(
    allocated.sort(),
    normalTasks.filter(isAttended).map(bakeryTaskId).sort(),
  );
}

test(
  "completed tasks require an ordered simulated observation and seeking preserves evidence",
  checkLifecycle,
);

function checkLifecycle() {
  const run = simulate(sampleSettings(), "normal");
  const untouched = structuredClone(run);
  const states = new Map();
  for (const event of run.taskEvents) {
    const id = event.task.id;
    if (event.kind === "started") {
      assert.equal(states.has(id), false);
      states.set(id, "running");
      assert.equal(event.time, event.task.start);
    } else if (event.kind === "picked-up") {
      assert.equal(states.get(id), "running");
      assert.equal(event.task.kind, "transfer");
      assert.equal(event.time, event.task.pickup);
      states.set(id, "picked-up");
    } else {
      assert.equal(
        states.get(id),
        event.task.kind === "transfer" ? "picked-up" : "running",
      );
      assert.deepEqual(event.evidence, {
        source: "assumed-simulation",
        bakeryTaskId: id,
        time: event.time,
      });
      states.set(id, "completed");
      assert.equal(event.time, event.task.end);
      assert.equal(taskAt(run, event.task, event.time).kind, "completed");
      assert.equal(taskAt(run, event.task, event.time - 0.001).kind, "running");
      assert.equal(
        taskAt(run, event.task, event.task.start - 0.001).kind,
        "queued",
      );
    }
  }
  assert.ok([...states.values()].every(isCompleted));
  assert.deepEqual(structuredClone(run), untouched);
}

test(
  "shift horizon retains unfinished work without fabricated completion events",
  checkHorizon,
);

function checkHorizon() {
  const run = simulate(
    settings({ horizonMinutes: 30, outageEnd: 29 }),
    "normal",
  );
  assert.equal(run.kind, "horizon");
  const active = run.intervals.filter(extendsPastHorizon.bind(null, run.end));
  assert.ok(active.length > 0);
  for (const task of active) {
    assert.equal(taskAt(run, task, run.end).kind, "running");
    // Even a caller seeking beyond the horizon cannot invent missing evidence.
    assert.equal(taskAt(run, task, task.end + 1).kind, "running");
  }
  assert.ok(run.taskEvents.every(withinHorizon.bind(null, run.end)));
}

test(
  "procedure canvas reads current task and wait from the shared run",
  checkCanvasProjection,
);

function checkCanvasProjection() {
  const run = simulate(sampleSettings(), "normal");
  const wait = run.intervals.find(isBakeWait);
  assert.ok(wait);
  const selection = { kind: "batch", id: wait.batch };
  assert.equal(operationWait(run, selection, wait.start, "bake"), wait.label);
  const task = operationTask(run, selection, wait.start, "bake");
  assert.ok(task);
  assert.ok(task.start >= wait.end);
  assert.equal(operationWait(run, selection, task.start, "bake"), null);
}

function isBakeWait(interval) {
  return interval.kind === "wait" && interval.station === "bake";
}

function isTask(interval) {
  return interval.kind !== "wait";
}

function bakeryTaskId(task) {
  return task.id;
}

function resourceIdentity(resource) {
  return [resource.id, resource.name];
}

function isAttended(task) {
  return task.attended;
}

function isCompleted(state) {
  return state === "completed";
}

function extendsPastHorizon(end, interval) {
  return interval.kind !== "wait" && interval.end > end;
}

function withinHorizon(end, event) {
  return event.time <= end;
}
