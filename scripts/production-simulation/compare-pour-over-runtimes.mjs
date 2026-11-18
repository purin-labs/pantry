// Compares a native and a Wasm pour-over campaign case by case against the
// declared cross-runtime tolerances. The two runtimes do not produce
// bit-identical physics, so each operator-visible quantity has a bound:
//
//   node scripts/production-simulation/compare-pour-over-runtimes.mjs NATIVE WASM [OUTPUT]
//
// NATIVE and WASM are output directories of verify-pour-over-journey.mjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Declared bounds. A scale reading has 0.1 g steps; a solver step is 2 ms. */
const POUR_OVER_RUNTIME_TOLERANCES = Object.freeze({
  pourReadingG: 0.2,
  pourStartS: 0.05,
  pourDurationS: 0.1,
  landingRadiusM: 0.001,
  brewS: 0.1,
  beverageMg: 500,
  kettleMg: 500,
  spentBedMg: 10,
  evaporatedMg: 10,
  spillMg: 10,
});

const [nativeDirectory, wasmDirectory, outputPath] = process.argv
  .slice(2)
  .map((path) => resolve(path));
assert.ok(nativeDirectory && wasmDirectory, "NATIVE and WASM are required");
const cases = readdirSync(nativeDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "executions")
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(
  readdirSync(wasmDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "executions")
    .map((entry) => entry.name)
    .sort(),
  cases,
  "both campaigns ran the same cases",
);

const T = POUR_OVER_RUNTIME_TOLERANCES;
const largest = {};
function within(name, native, wasm, bound) {
  const difference = Math.abs(native - wasm);
  largest[name] = Math.max(largest[name] ?? 0, difference);
  assert.ok(difference <= bound, `${name}: ${native} and ${wasm}`);
}
function measured(result) {
  const values = {};
  for (const entry of [...(result.lots ?? []), ...(result.losses ?? [])])
    values[entry.product] = entry.mg;
  return values;
}

const compared = {};
for (const name of cases) {
  const read = (directory) =>
    JSON.parse(readFileSync(join(directory, name, "result.json"), "utf8"));
  const native = read(nativeDirectory);
  const wasm = read(wasmDirectory);
  const a = native.report;
  const b = wasm.report;
  assert.equal(a.outcome.kind, b.outcome.kind, `${name} outcome`);
  assert.equal(a.outcome.reason, b.outcome.reason, `${name} failure`);
  assert.deepEqual(
    a.deviations.map((deviation) => deviation.kind),
    b.deviations.map((deviation) => deviation.kind),
    `${name} deviations`,
  );
  assert.equal(a.pours.length, b.pours.length, `${name} pours`);
  for (const [index, pour] of a.pours.entries()) {
    const other = b.pours[index];
    assert.equal(pour.finalG === null, other.finalG === null);
    if (pour.finalG !== null)
      within("pourReadingG", pour.finalG, other.finalG, T.pourReadingG);
    within("pourStartS", pour.detectedS, other.detectedS, T.pourStartS);
    if (pour.finalG !== null)
      within("pourDurationS", pour.durationS, other.durationS, T.pourDurationS);
    within(
      "landingRadiusM",
      pour.maxLandingRadiusM,
      other.maxLandingRadiusM,
      T.landingRadiusM,
    );
  }
  if (a.brewS !== null) within("brewS", a.brewS, b.brewS, T.brewS);
  if (a.outcome.kind === "completed") {
    const x = measured(native);
    const y = measured(wasm);
    within("beverageMg", x["brewed-coffee"], y["brewed-coffee"], T.beverageMg);
    within("kettleMg", x["hot-water"], y["hot-water"], T.kettleMg);
    within(
      "spentBedMg",
      x["spent-coffee-bed"],
      y["spent-coffee-bed"],
      T.spentBedMg,
    );
    within(
      "evaporatedMg",
      x["evaporated-water"],
      y["evaporated-water"],
      T.evaporatedMg,
    );
    within("spillMg", x["spilled-water"], y["spilled-water"], T.spillMg);
  } else {
    // A failed brew reports no lots; its retained water must still agree.
    within(
      "kettleMg",
      native.water.kettleG * 1000,
      wasm.water.kettleG * 1000,
      T.kettleMg,
    );
    within(
      "beverageMg",
      native.water.serverG * 1000,
      wasm.water.serverG * 1000,
      T.beverageMg,
    );
  }
  compared[name] = {
    outcome: a.outcome.kind,
    native: native.finalCheckpoint ?? native.checkpoint,
    wasm: wasm.finalCheckpoint ?? wasm.checkpoint,
  };
}
const report = { passed: true, tolerances: T, largest, cases: compared };
if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, largest }));
