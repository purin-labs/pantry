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
const baseline = JSON.parse(
  readFileSync(join(headless, "baseline.json"), "utf8"),
);
const browser = report.checks;
assert.equal(baseline.identity.bundle, browser.bundle);
const histories = [];
const worlds = [];
for (const run of [baseline, browser.continued]) {
  const accepted = [];
  for (const { sequence, execution, ...event } of run.events)
    if (event.kind !== "command-admitted") accepted.push(event);
  histories.push(canonicalJson(accepted));
  const { identity, events, commands, position, ...state } = run;
  worlds.push(canonicalJson({ ...state, time: position.time }));
}
assert.equal(histories[0], histories[1]);
assert.equal(worlds[0], worlds[1]);
writeFileSync(
  join(dirname(browserPath), "artifact-report.json"),
  JSON.stringify(
    {
      result: "passed",
      bundle: browser.bundle,
      seconds: browser.seconds,
      restores: browser.saves.length,
      sameHistoryAndWorld: true,
    },
    null,
    2,
  ),
);
console.log(
  "Headless and browser oven engine histories and world states match",
);
