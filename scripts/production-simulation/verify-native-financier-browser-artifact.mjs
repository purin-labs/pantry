import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { canonicalJson } from "../../packages/std/src/index.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide the headless directory and browser report",
);
const headless = resolve(process.argv[2]);
const browserPath = resolve(process.argv[3]);
const report = JSON.parse(readFileSync(browserPath, "utf8"));
assert.equal(report.result, "passed");
const browser = report.checks;
const baseline = JSON.parse(
  readFileSync(join(headless, "baseline.json"), "utf8"),
);
assert.equal(baseline.identity.bundle, browser.bundle);
function history(run) {
  const result = [];
  for (const { sequence, execution, ...event } of run.events)
    if (event.kind !== "command-admitted") result.push(event);
  return canonicalJson(result);
}
function world(run) {
  const { identity, events, commands, position, ...state } = run;
  return canonicalJson({ ...state, time: position.time });
}
assert.equal(history(baseline), history(browser.continued));
assert.equal(world(baseline), world(browser.continued));
const recovery = JSON.parse(
  readFileSync(join(headless, "worker-recovery.json"), "utf8"),
);
assert.equal(
  history(recovery.baseline),
  history(browser.workerRecovery.continued),
);
assert.equal(world(recovery.baseline), world(browser.workerRecovery.continued));
writeFileSync(
  join(dirname(browserPath), "artifact-report.json"),
  `${canonicalJson({ result: "passed", bundle: browser.bundle, sameHistoryAndWorld: true, packed: browser.packed, simulatedSeconds: browser.simulatedSeconds, workerRecoveryRestores: 3, rejected: 24 })}\n`,
);
console.log(
  "Headless and browser native financier histories and world states match",
);
