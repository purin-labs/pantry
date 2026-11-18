// The input of verify-file-execution.mjs for one retained runtime: the two
// cells of the recurring stress route, prepared by that runtime, and the
// route's scenario. Refactor 16 step 6 uses it to save a run under the step 5
// bundle and to resume it after the next engine release.
//
//   node scripts/production-simulation/write-retained-case.mjs RUNTIME_BUNDLE_DIRECTORY NEW_OUTPUT_DIRECTORY
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { parseNativeCell } from "../../packages/production-simulation/src/execution-entry.ts";
import { recurringColdCellScenario } from "../../packages/production-simulation/src/recipes/recurring-cold-cell.ts";
import { prepareCell } from "./build-execution-bundle.mjs";

assert.equal(
  process.argv.length,
  4,
  "Provide a runtime bundle directory and a new output directory.",
);
const [runtime, destination] = process.argv
  .slice(2)
  .map((path) => resolve(path));
assert.ok(!existsSync(destination), "Choose a new output directory.");
mkdirSync(destination, { recursive: true });
const cells = [
  await prepareCell(runtime, "source-cell"),
  await prepareCell(runtime, "receiving-cell"),
];
const definitions = cells.map((raw) => {
  const parsed = parseNativeCell(raw);
  assert.ok(parsed.ok, JSON.stringify(parsed.error));
  return {
    id: parsed.value.cellId,
    modelHash: parsed.value.modelHash,
    controllerSourceHash: parsed.value.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel: "cold-cell-rest.1",
  };
});
const scenario = await recurringColdCellScenario(definitions, {
  kind: "stress",
  bufferSlots: 1,
});
writeFileSync(join(destination, "cells.json"), `${canonicalJson(cells)}\n`);
writeFileSync(
  join(destination, "scenario.json"),
  `${canonicalJson(scenario)}\n`,
);
console.log(`Retained case written: ${destination}`);
