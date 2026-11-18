import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../../packages/std/src/index.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide the headless directory and browser report",
);
const headless = resolve(process.argv[2]);
const browserPath = resolve(process.argv[3]);
const browser = JSON.parse(readFileSync(browserPath, "utf8"));
assert.equal(browser.result, "passed");

function history(run) {
  const result = [];
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (event.kind !== "command-admitted") result.push(event);
  return result;
}

function world(run) {
  const {
    identity: _identity,
    events: _events,
    commands: _commands,
    position,
    ...state
  } = run;
  return { ...state, time: position.time };
}

const comparisons = [];
for (const report of browser.checks.reports) {
  const name = report.name;
  const reference = JSON.parse(
    readFileSync(join(headless, `${name}-persistent.json`), "utf8"),
  );
  assert.equal(
    reference.identity.bundle,
    report.bundle,
    "Both hosts must execute the same retained engine",
  );
  assert.equal(
    canonicalJson(history(reference)),
    canonicalJson(history(report.continued)),
    `${name} accepted history`,
  );
  assert.equal(
    canonicalJson(world(reference)),
    canonicalJson(world(report.continued)),
    `${name} final world`,
  );
  comparisons.push({
    name,
    bundle: report.bundle,
    simulatedSeconds: report.simulatedSeconds,
    sameHistoryAndWorld: true,
  });
}
assert.equal(comparisons.length, 4);
for (const report of [
  ...browser.checks.preparation,
  ...browser.checks.recipes,
]) {
  const reference = JSON.parse(
    readFileSync(join(headless, `${report.name}-baseline.json`), "utf8"),
  );
  assert.equal(reference.identity.bundle, report.bundle);
  assert.equal(
    canonicalJson(history(reference)),
    canonicalJson(history(report.continued)),
  );
  assert.equal(
    canonicalJson(world(reference)),
    canonicalJson(world(report.continued)),
  );
  comparisons.push({
    name: report.name,
    bundle: report.bundle,
    status: report.status,
    sameHistoryAndWorld: true,
  });
}
assert.equal(comparisons.length, 8);
writeFileSync(
  join(dirname(browserPath), "artifact-report.json"),
  `${canonicalJson({ result: "passed", comparisons })}\n`,
);
console.log("Headless and browser financier histories and world states match");
