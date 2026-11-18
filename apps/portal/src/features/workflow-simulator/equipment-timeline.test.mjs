import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettings, sampleSettings } from "@seams/bakery-model/bakery";
import {
  simulate,
  stations,
} from "@seams/production-simulation/recipes/bakery/schedule";
import {
  equipmentAt,
  equipmentTimeline,
  equipmentSummary,
} from "@seams/production-simulation/simulator/equipment-timeline";

function simulateSettings(changes = {}, variant = "normal") {
  const parsed = parseSettings({ ...sampleSettings(), ...changes });
  assert.equal(parsed.kind, "valid");
  return simulate(parsed.settings, variant);
}

test(
  "equipment reservations include incoming handling and release the source only at pickup",
  checkHandoffs,
);
function checkHandoffs() {
  const run = simulateSettings({ workerCount: 2 });
  const original = structuredClone(run);
  for (const task of run.intervals) {
    if (task.kind !== "transfer") continue;
    assert.ok(
      equipmentAt(run, task.station, task.start).batches.includes(task.batch),
    );
    assert.ok(
      equipmentAt(run, task.from, task.pickup - 0.001).batches.includes(
        task.batch,
      ),
    );
    assert.ok(
      !equipmentAt(run, task.from, task.pickup).batches.includes(task.batch),
    );
    assert.ok(
      equipmentAt(run, task.station, task.end).batches.includes(task.batch),
    );
  }
  for (const station of stations) {
    const spans = equipmentTimeline(run, station.id);
    assert.equal(spans[0].start, 0);
    assert.equal(spans.at(-1).end, run.end);
    let end = 0;
    for (const span of spans) {
      assert.equal(span.start, end);
      assert.ok(span.end > span.start);
      assert.deepEqual(
        span.allocation,
        equipmentAt(run, station.id, span.start),
      );
      assert.deepEqual(
        span.allocation,
        equipmentAt(run, station.id, (span.start + span.end) / 2),
      );
      assert.ok(
        span.allocation.capacity.used <= span.allocation.capacity.total,
      );
      end = span.end;
    }
    assert.deepEqual(equipmentAt(run, station.id, run.end).batches, []);
  }
  assert.deepEqual(structuredClone(run), original);
}

test(
  "shared oven cycles count trays once and preserve reservations through unloading",
  checkCycles,
);
function checkCycles() {
  const run = simulateSettings({
    workerCount: 3,
    stage: 1,
    portion: 1,
    loadWindow: 10,
  });
  const cycle = run.cycles.find(isSharedCycle);
  assert.ok(cycle);
  const during = equipmentAt(run, "bake", cycle.start);
  assert.equal(during.cycle, cycle);
  assert.deepEqual(during.batches, [...cycle.batches].sort());
  assert.equal(during.capacity.used, cycle.trays);
  const unloading = equipmentAt(run, "bake", cycle.end);
  assert.equal(unloading.cycle, null);
  assert.deepEqual(unloading.batches, during.batches);
  const spans = equipmentTimeline(run, "bake");
  assert.equal(spans.filter(inCycle.bind(null, cycle)).length, 1);
}

function isSharedCycle(cycle) {
  return cycle.batches.length > 1;
}
function inCycle(cycle, span) {
  return span.allocation.cycle === cycle;
}

test(
  "an outage is distinct from occupied capacity and does not erase an existing bake",
  checkOutage,
);
function checkOutage() {
  const baseline = simulateSettings();
  const outageStart = Math.ceil(baseline.cycles[0].start / 60) + 1;
  const run = simulateSettings(
    { outageStart, outageEnd: outageStart + 2 },
    "outage",
  );
  const during = equipmentAt(run, "bake", outageStart * 60);
  assert.equal(during.unavailable, true);
  assert.ok(during.cycle);
  assert.equal(during.cycle.end, baseline.cycles[0].end);
  assert.equal(during.capacity.used, during.cycle.trays);
  assert.match(equipmentSummary(during), /Existing bake continues/);
  const pendingOutage = simulateSettings({}, "outage");
  assert.doesNotMatch(
    equipmentSummary(equipmentAt(pendingOutage, "bake", 600)),
    /Existing bake/,
  );
  assert.equal(equipmentAt(run, "cool", outageStart * 60).unavailable, false);
  const spans = equipmentTimeline(run, "bake");
  assert.ok(spans.some(startsAtOutage.bind(null, outageStart * 60)));
  assert.equal(
    equipmentAt(run, "bake", (outageStart + 2) * 60).unavailable,
    false,
  );
}
function startsAtOutage(time, span) {
  return span.start === time && span.allocation.unavailable;
}

test(
  "shift end retains unresolved reservations and seeking cannot release them",
  checkHorizon,
);
function checkHorizon() {
  const run = simulateSettings({ horizonMinutes: 30, outageEnd: 29, bake: 60 });
  assert.equal(run.kind, "horizon");
  const original = structuredClone(run);
  const allocation = equipmentAt(run, "bake", run.end);
  assert.ok(allocation.batches.length > 0);
  assert.ok(allocation.cycle);
  assert.deepEqual(equipmentAt(run, "bake", run.end + 10000), allocation);
  const spans = equipmentTimeline(run, "bake");
  assert.equal(spans.at(-1).end, run.end);
  for (const time of [run.end, 0, run.end / 2, run.end]) {
    for (const station of stations) equipmentAt(run, station.id, time);
  }
  assert.deepEqual(structuredClone(run), original);
}
