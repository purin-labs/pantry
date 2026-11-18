// The headless runs of Refactor 16 phase 1: the scenarios, one run from its
// scenario to its end, and the fingerprints that compare two runs. The phase
// 1 measurement and the physics result cache journey use them.
//   one-cell   the four-order cold-cell scenario of Plan 70 J1/J2, one cell
//   two-cell   the same orders with a second cell after a handoff (Plan 70 J2)
//   orders-24  the 24-order stress route of Plan 70C (one buffer slot)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { recurringColdCellScenario } from "../../packages/production-simulation/src/recipes/recurring-cold-cell.ts";
import { prepareCell } from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import { Fingerprint, recordedPhysics } from "./physics-fingerprint.mjs";
import { twoCellScenarios } from "./two-cell-scenario.mjs";

export const PHASE_1_RUNS = ["one-cell", "two-cell", "orders-24"];

export function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}

function definition(cell) {
  return {
    id: cell.cellId,
    modelHash: cell.modelHash,
    controllerSourceHash: cell.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel: "cold-cell-rest.1",
  };
}

/** The event history without the fields that name the execution. */
export function history(events) {
  const result = [];
  for (const { sequence: _sequence, execution: _execution, ...event } of events)
    if (event.kind !== "command-admitted") result.push(event);
  return result;
}

/** The cell definitions and the compiled scenario of one phase 1 run. */
export async function phase1Scenario(E, runtime, name) {
  if (name === "orders-24") {
    const cells = [
      await prepareCell(runtime, "source-cell"),
      await prepareCell(runtime, "receiving-cell"),
    ];
    const parsed = cells.map((cell) => value(E.parseNativeCell(cell)));
    return {
      cells,
      scenario: await recurringColdCellScenario(parsed.map(definition), {
        kind: "stress",
        bufferSlots: 1,
      }),
    };
  }
  const cells = [
    await prepareCell(runtime, "cold-cell-1"),
    await prepareCell(runtime, "cold-cell-2"),
  ];
  const [first, second] = cells.map((cell) => value(E.parseNativeCell(cell)));
  const { base, scenario } = await twoCellScenarios(first, second);
  return name === "one-cell"
    ? { cells: [cells[0]], scenario: base }
    : { cells, scenario };
}

/**
 * Begins `scenario` on `transport` and drives it to its end without a
 * pause. `onDriveStart` runs after the cells open, before the first drive.
 */
export async function runToEnd(
  E,
  transport,
  bundle,
  { cells, scenario },
  name,
  onDriveStart = () => {},
) {
  const host = collectingExecutionHost(E, transport);
  const opened = performance.now();
  const began = await host.handle({
    kind: "begin",
    bundle,
    cells,
    identity: {
      runId: `phase-1-${name}`,
      executionId: `execution-${name}`,
      hostSession: `host-${name}`,
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));
  const beginMs = performance.now() - opened;
  onDriveStart();
  const started = performance.now();
  let drives = 0;
  let view;
  for (;;) {
    const reply = await host.handle({
      kind: "drive",
      turns: 512,
      until: scenario.limits.horizon,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply).slice(0, 400));
    drives += 1;
    view = reply.view;
    if (
      view.status.kind === "completed" ||
      // The one-cell scenario ends after two orders: both trays then wait on
      // the outbound shelf, as in Plan 70 J1.
      view.status.kind === "blocked" ||
      view.time >= scenario.limits.horizon
    )
      break;
    assert.equal(view.status.kind, "awaiting-execution", JSON.stringify(view));
  }
  const driveMs = performance.now() - started;
  const state = await host.handle({ kind: "state" });
  assert.equal(state.kind, "state");
  return { host, view, state, beginMs, driveMs, drives };
}

/**
 * What two runs must share. `fingerprint`: the results, the event history
 * and the final world, without build and run identities. `recorded`: every
 * recorded sample, contact and event by step (`recordedPhysics`).
 * `segments`: the SHA-256 of each operation recording in stored order; the
 * controller wrote those bytes, so equal digests mean equal bytes.
 */
export async function runFingerprints(E, run) {
  const { host, state } = run;
  const results = E.runResults(state.run, {
    after: null,
    through: state.run.position.time,
  });
  const fingerprint = new Fingerprint();
  fingerprint.add(results);
  fingerprint.add(history(state.run.events));
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    ...world
  } = state.run;
  fingerprint.add(world);
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved).slice(0, 400));
  let recordingBytes = 0;
  const records = [];
  const segments = createHash("sha256");
  let segmentCount = 0;
  for (const artifact of saved.artifacts)
    if (artifact.role === "recording-segment") {
      recordingBytes += artifact.content.length;
      for (const record of value(E.unpackRecordings(artifact.content))) {
        records.push(record.content);
        if (!record.content.startsWith('{"kind":"accepted-cell-recording"')) {
          segments.update(record.digest);
          segmentCount += 1;
        }
      }
    }
  const recorded = recordedPhysics(records);
  await host.handle({ kind: "dispose" });
  return {
    results,
    fingerprint: fingerprint.digest(),
    recorded,
    segments: { count: segmentCount, digest: segments.digest("hex") },
    recordingBytes,
    recordings: records.length,
  };
}
