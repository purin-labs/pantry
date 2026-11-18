import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { parsePhysicsRecording } from "@seams/bakery-model/bakery-physics";
import { PhysicsModel } from "./spatial/physics-model.ts";
import { compileWorkcellInput } from "@seams/production-simulation/recipes/bakery/workcell-input";
import {
  reserveWorkcell,
  settleWorkcell,
  workcellAt,
} from "@seams/production-simulation/recipes/bakery/workcell-attempt";
import { workcellView } from "@seams/production-simulation/simulator/workcell-view";
import {
  initialPlaybackSession,
  loadWorkcellReplay,
  recordingReplayView,
  seekActivePlayback,
} from "@seams/production-simulation/simulator/playback-state";

const raw = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../assets/bakery-mujoco/fr10-workcell/recordings/nominal.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function evidence(value = raw) {
  const parsed = parsePhysicsRecording(JSON.stringify(value));
  assert.equal(parsed.kind, "accepted", parsed.message);
  return parsed.recording;
}

function reserve(recording, dispatchSeconds = "0") {
  const result = compileWorkcellInput(
    recording.request,
    dispatchSeconds,
    "cold-cell-1",
  );
  assert.equal(result.kind, "ready", result.message);
  const reserved = reserveWorkcell({ kind: "empty" }, result.input);
  assert.equal(reserved.kind, "reserved", reserved.message);
  return reserved.attempt;
}

function accept(recording, dispatchSeconds = "0") {
  const settled = settleWorkcell(
    reserve(recording, dispatchSeconds),
    recording,
  );
  assert.equal(settled.kind, "accepted", settled.message);
  return settled.attempt;
}

function viewAt(attempt, time) {
  return workcellView(
    attempt,
    { kind: "resource", id: "source-table-1" },
    recordingReplayView(
      seekActivePlayback(
        loadWorkcellReplay(initialPlaybackSession(), attempt),
        time,
        0,
      ),
    ),
  );
}

test(
  "a pending task stays timeless until its evidence is accepted",
  waitingView,
);
function waitingView() {
  const waiting = reserve(evidence());
  const view = workcellView(
    waiting,
    { kind: "resource", id: "fr10-1" },
    recordingReplayView(initialPlaybackSession()),
  );
  assert.equal(view.cursor.kind, "awaiting");
  assert.equal(view.cursor.time, 0);
  assert.equal(view.cursor.end, undefined);
  assert.equal(workcellAt(waiting, 10_000).kind, "awaiting-evidence");
}

test(
  "an accepted recording drives the view and resource projection on one cursor",
  attachedView,
);
function attachedView() {
  const recording = evidence();
  const attempt = accept(recording);
  const pickup =
    recording.events.find(pickupObservation).step * recording.request.timestep;
  let view = viewAt(attempt, 0);
  assert.equal(view.cursor.kind, "attached");
  assert.equal(view.cursor.end, attempt.settledTime);
  assert.equal(workcellAt(attempt, 0).kind, "running");
  view = viewAt(attempt, pickup);
  assert.equal(view.cursor.time, pickup);
  assert.equal(workcellAt(attempt, pickup).tray, "gripped");
  assert.equal(workcellAt(attempt, pickup).resources.source, "available");
  const settled = workcellAt(attempt, attempt.settledTime);
  assert.equal(settled.resources.destination, "occupied");
  assert.equal(settled.resources.arm, "available");
}

function pickupObservation(event) {
  return event.kind === "pickup";
}

test(
  "scene objects resolve the bound resources and moving tray bounds follow its pose",
  sceneBinding,
);
function sceneBinding() {
  const recording = evidence();
  const model = new PhysicsModel(recording);
  const bound = Object.values(accept(recording).input.bindings);
  const checks = [
    ["table_top", "source-table-1"],
    ["rack_rail_left", "rack-slot-1"],
    ["clamp_palm", "clamp-1"],
    ["cold_contents", "cold-tray-1"],
    ["pedestal_plate", "fr10-1"],
  ];
  try {
    for (const [name, expected] of checks) {
      const object = model.root.getObjectByName(name);
      assert.ok(object);
      const id = model.resourceForObject(object);
      assert.equal(id, expected);
      assert.ok(bound.includes(id));
      assert.equal(model.resourceBounds(id).isEmpty(), false);
    }
    const start = model
      .resourceBounds("cold-tray-1")
      .getCenter(new THREE.Vector3());
    model.update(recording.outcome.step * recording.request.timestep);
    const end = model
      .resourceBounds("cold-tray-1")
      .getCenter(new THREE.Vector3());
    assert.ok(start.distanceTo(end) > 0.1);
  } finally {
    model.dispose();
  }
}

test(
  "runner failure projects open-ended holds without enabling another reservation",
  heldView,
);
function heldView() {
  const attempt = accept(
    evidence({
      ...raw,
      samples: [raw.samples[0]],
      events: [{ kind: "failure", step: 0, label: "Runner stopped" }],
      outcome: { kind: "execution-error", step: 0, message: "Runner stopped" },
    }),
  );
  assert.equal(viewAt(attempt, 0).cursor.end, 0);
  const projection = workcellAt(attempt, 0);
  assert.equal(projection.kind, "recovery-required");
  assert.deepEqual(Object.values(projection.resources), Array(6).fill("held"));
  assert.equal(reserveWorkcell(attempt, attempt.input).kind, "rejected");
}

test(
  "failures leave the tray location unknown and hold every resource",
  failureHolds,
);
function failureHolds() {
  const outcomes = [
    {
      kind: "failed",
      step: raw.outcome.step,
      reason: "Tray slipped.",
      trayDisposition: "unknown",
    },
    {
      kind: "execution-error",
      step: raw.outcome.step,
      message: "Runner stopped.",
    },
  ];
  for (const outcome of outcomes) {
    const attempt = accept(
      evidence({
        ...raw,
        events: [
          ...raw.events.filter(withoutPlacement),
          { kind: "failure", step: outcome.step, label: "Transfer stopped" },
        ],
        outcome,
      }),
      "60",
    );
    assert.equal(workcellAt(attempt, attempt.settledTime).tray, "unknown");
    assert.equal(workcellAt(attempt, 60).kind, "running");
    assert.deepEqual(Object.values(attempt.resources), Array(6).fill("held"));
  }
}

function withoutPlacement(event) {
  return event.kind !== "placement";
}
