import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rackLayoutHash } from "../../packages/bakery-model/src/bakery-physics.ts";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { rackPlacementFit } from "../../apps/portal/src/features/workflow-simulator/rack-layout.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the runs saved by verify-tray-layout-drag-browser.js with WebGL
// and without it (--mode fallback): the dragged placement was applied to
// tray A's request and simulated in browser MuJoCo.
//
//   tsx verify-tray-layout-drag-artifacts.mjs WEBGL_DIRECTORY FALLBACK_DIRECTORY
assert.equal(process.argv.length, 4, "Give the WebGL and fallback outputs.");
const evidence = resolve(process.argv[2]);
const fallbackEvidence = resolve(process.argv[3]);

async function verify(directory) {
  const opened = await parseRehearsalWorkcells(
    readFileSync(join(directory, "applied.json"), "utf8"),
  );
  assert.equal(opened.kind, "ready", opened.message);
  const [tray] = opened.plan.operations;
  assert.equal(tray.id, "batch:A:native:1");
  assert.equal(tray.attempt.kind, "completed");
  const request = tray.attempt.input.request;
  assert.equal(request.bakeryTaskId, "table-to-rack");
  assert.equal(request.execution.backend, "browser");
  assert.equal(request.layout.kind, "rack-translation");
  assert.equal(
    request.modelHash,
    await rackLayoutHash(request.layout, request.robot),
  );
  assert.notEqual(rackPlacementFit(request.layout).kind, "blocked");
  const recording = tray.attempt.recording;
  assert.deepEqual(recording.request.layout, request.layout);
  assert.equal(recording.request.modelHash, request.modelHash);
  assert.equal(recording.outcome.kind, "completed");
  const run = simulateProduction(opened.plan);
  assert.equal(run.kind, "complete");
  return {
    layout: request.layout,
    modelHash: request.modelHash,
    outcome: recording.outcome.kind,
    end: run.end,
  };
}

const report = {
  status: "passed",
  webgl: await verify(evidence),
  fallback: await verify(fallbackEvidence),
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
