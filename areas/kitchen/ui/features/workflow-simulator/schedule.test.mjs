import { parseSettings, sampleSettings } from "@purin-labs/bakery-model/bakery";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchAt,
  doorAt,
  machineAt,
  metrics,
  simulate,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";

test(
  "shift replay respects station capacity and worker exclusivity across 108 configurations",
  checkConfigurations,
);
function checkConfigurations() {
  for (const batchCount of [1, 2, 3, 4, 5, 6]) {
    for (const workerCount of [1, 2, 3]) {
      for (const rackTrays of [2, 4, 16]) {
        for (const variant of ["normal", "outage"]) {
          const input = parseSettings({
            ...sampleSettings(),
            batchCount,
            workerCount,
            rackTrays,
          });
          assert.equal(input.kind, "valid");
          const run = simulate(input.settings, variant);
          assert.deepEqual(simulate(input.settings, variant), run);
          const workers = new Map();
          const changes = [];
          for (const interval of run.intervals) {
            if (interval.kind === "wait") continue;
            if (interval.attended) {
              assert.ok(
                interval.start >= (workers.get(interval.executor) ?? 0),
              );
              workers.set(interval.executor, interval.end);
            }
            if (interval.kind === "transfer") {
              changes.push({
                time: interval.start,
                station: interval.station,
                batch: interval.batch,
                delta: 1,
              });
              changes.push({
                time: interval.pickup,
                station: interval.from,
                batch: interval.batch,
                delta: -1,
              });
            } else {
              if (interval.station === "stage")
                changes.push({
                  time: interval.start,
                  station: "stage",
                  batch: interval.batch,
                  delta: 1,
                });
              if (interval.station === "pack")
                changes.push({
                  time: interval.end,
                  station: "pack",
                  batch: interval.batch,
                  delta: -1,
                });
            }
          }
          changes.sort(orderChanges);
          const occupants = new Map();
          for (const event of changes) {
            const occupied = occupants.get(event.station) ?? new Set();
            if (event.delta < 0) assert.ok(occupied.delete(event.batch));
            else {
              assert.ok(!occupied.has(event.batch));
              occupied.add(event.batch);
            }
            const capacity =
              event.station === "cool"
                ? rackTrays
                : event.station === "bake"
                  ? run.settings.ovenTrays
                  : run.settings.traysPerBatch;
            assert.ok(occupied.size * run.settings.traysPerBatch <= capacity);
            occupants.set(event.station, occupied);
          }
          for (const batch of run.batches) {
            let end = batch.release;
            for (const interval of run.intervals.filter(
              forBatch.bind(null, batch.id),
            )) {
              assert.equal(interval.start, end);
              end = interval.end;
            }
            if (run.kind === "complete")
              assert.equal(batchAt(run, batch, run.end).kind, "complete");
          }
        }
      }
    }
  }
}
function orderChanges(a, b) {
  return a.time - b.time || a.delta - b.delta;
}
function forBatch(id, interval) {
  return interval.batch === id;
}

test(
  "outage delays new work, preserves an existing bake, and exposes queues",
  checkOutage,
);
function checkOutage() {
  const normal = simulate(sampleSettings(), "normal");
  const outage = simulate(sampleSettings(), "outage");
  assert.ok(
    metrics(outage).late + metrics(outage).unfinished >= metrics(normal).late,
  );
  assert.ok(outage.end > normal.end);
  assert.ok(normal.intervals.some(isOvenWait));
  const settings = parseSettings({
    ...sampleSettings(),
    outageStart: Math.ceil(normal.cycles[0].start / 60) + 1,
    outageEnd: 40,
  });
  assert.equal(settings.kind, "valid");
  const duringBake = simulate(settings.settings, "outage");
  assert.equal(
    duringBake.intervals.find(firstBake).end,
    normal.intervals.find(firstBake).end,
  );
}
function firstBake(interval) {
  return (
    interval.kind === "process" &&
    interval.station === "bake" &&
    interval.batch === "A"
  );
}
function isOvenWait(interval) {
  return interval.kind === "wait" && interval.station === "bake";
}

test(
  "doors replay from simulated time through opening, closing and backward seeks",
  checkDoors,
);
function checkDoors() {
  const run = simulate(sampleSettings(), "normal");
  const transfer = run.intervals.find(ovenLoad);
  assert.equal(doorAt(run, "bake", transfer.loadedEnd - 1, false), 0);
  assert.equal(doorAt(run, "bake", transfer.loadedEnd + 0.375, false), 0.5);
  assert.equal(doorAt(run, "bake", transfer.loadedEnd + 2, false), 1);
  assert.equal(doorAt(run, "bake", transfer.end, false), 0);
  assert.equal(doorAt(run, "bake", transfer.loadedEnd + 0.375, false), 0.5);
  assert.equal(doorAt(run, "bake", transfer.loadedEnd, true), 1);
}
function ovenLoad(interval) {
  return interval.kind === "transfer" && interval.station === "bake";
}

test(
  "shift horizon distinguishes unfinished work from completed late batches",
  checkHorizon,
);
function checkHorizon() {
  const result = parseSettings({
    ...sampleSettings(),
    horizonMinutes: 30,
    bake: 60,
  });
  assert.equal(result.kind, "valid");
  const run = simulate(result.settings, "normal");
  assert.equal(run.kind, "horizon");
  assert.equal(run.end, 1800);
  assert.equal(metrics(run).unfinished, 3);
  assert.equal(metrics(run).late, 0);
  const complete = simulate(sampleSettings(), "normal");
  const exact = parseSettings({
    ...sampleSettings(),
    batchCount: 1,
    horizonMinutes: 90,
  });
  assert.equal(exact.kind, "valid");
  assert.equal(simulate(exact.settings, "normal").kind, "complete");
  assert.ok(complete.events.every(withinEnd.bind(null, complete.end)));
}
function withinEnd(end, event) {
  return event <= end;
}

test(
  "whole batches share tray-limited cycles and doors stay closed during baking",
  checkCycles,
);
function checkCycles() {
  for (const traysPerBatch of [1, 2, 3, 4]) {
    for (const loadWindow of [0, 10, 30]) {
      const input = parseSettings({
        ...sampleSettings(),
        batchCount: 6,
        workerCount: 3,
        traysPerBatch,
        loadWindow,
        horizonMinutes: 360,
      });
      assert.equal(input.kind, "valid");
      const run = simulate(input.settings, "normal");
      assert.equal(run.kind, "complete");
      let previousEnd = 0;
      for (const cycle of run.cycles) {
        assert.ok(cycle.start >= previousEnd);
        previousEnd = cycle.end;
        assert.equal(cycle.trays, cycle.batches.length * traysPerBatch);
        assert.ok(cycle.trays <= input.settings.ovenTrays);
        if (loadWindow === 0) assert.equal(cycle.batches.length, 1);
        for (const id of cycle.batches) {
          const bake = run.intervals.find(bakeForBatch.bind(null, id));
          assert.equal(bake.start, cycle.start);
          assert.equal(bake.end, cycle.end);
        }
        for (let time = cycle.start; time < cycle.end; time++) {
          assert.equal(doorAt(run, "bake", time, false), 0);
        }
        for (const task of run.intervals) {
          if (
            task.kind === "transfer" &&
            task.station === "bake" &&
            task.start >= cycle.end
          ) {
            for (const unload of run.intervals) {
              if (
                unload.kind === "transfer" &&
                unload.from === "bake" &&
                cycle.batches.includes(unload.batch)
              ) {
                assert.ok(task.start >= unload.end);
              }
            }
          }
        }
      }
      for (const batch of run.batches) {
        assert.equal(
          batch.quantity,
          input.settings.piecesPerTray * traysPerBatch,
        );
        const demould = run.intervals.find(
          demouldForBatch.bind(null, batch.id),
        );
        assert.equal(demould.attended, true);
        assert.equal(
          demould.end - demould.arrival,
          input.settings.demould * 60,
        );
      }
    }
  }
  const sharedSettings = parseSettings({ ...sampleSettings(), loadWindow: 10 });
  assert.equal(sharedSettings.kind, "valid");
  const shared = simulate(sharedSettings.settings, "normal");
  assert.deepEqual(shared.cycles[0].batches, ["A", "B"]);
  assert.equal(
    machineAt(shared, "bake", shared.cycles[0].start).occupants.length,
    2,
  );
}
function bakeForBatch(id, task) {
  return (
    task.kind === "process" && task.station === "bake" && task.batch === id
  );
}
function demouldForBatch(id, task) {
  return (
    task.kind === "process" && task.operation === "demould" && task.batch === id
  );
}

test(
  "input boundary rejects invalid durations, capacities and outage windows",
  checkInputs,
);
function checkInputs() {
  for (const patch of [
    { stage: "" },
    { stage: true },
    { workerCount: 0 },
    { batchCount: 7 },
    { bake: 1.5 },
    { cool: Infinity },
    { rackTrays: 1 },
    { ovenTrays: 1 },
    { loadSeconds: 0 },
    { demould: 0 },
    { outageStart: 30, outageEnd: 20 },
    { horizonMinutes: 30, outageEnd: 60 },
  ])
    assert.equal(
      parseSettings({ ...sampleSettings(), ...patch }).kind,
      "invalid",
    );
}
