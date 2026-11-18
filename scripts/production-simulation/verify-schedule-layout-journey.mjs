// Compile the same financier recipe for different floor layouts in one
// process, in both orders, and check that each result depends only on its own
// layout (Refactor 16 step 15A, finding F29).
//
// A reference for each layout comes from a fresh process that compiles only
// that layout. In one process the journey then compiles pairs of layouts in
// both orders and compares each result with its reference. The result is the
// compiled engine scenario, its workflow revisions, the worker travel times
// in it, and the schedule run of the same input.
//
// Before step 15A the schedule module kept one mutable layout, and the only
// way to give a layout was setScheduleSpatialLayout. The journey still runs on
// that code ("module-state" mode): it sets a layout before it compiles that
// layout, and it sets nothing for the built-in layout, as the scripts and the
// financier compiler did. There a compile follows the layout that the module
// saw last. On the new code ("explicit" mode) the layout is an argument.
//
// Usage: tsx scripts/production-simulation/verify-schedule-layout-journey.mjs <fresh output dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  parseSettings,
  sampleSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import { compileFinancier } from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import * as schedule from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

const script = fileURLToPath(import.meta.url);
const mode =
  typeof schedule.setScheduleSpatialLayout === "function"
    ? "module-state"
    : "explicit";

// Three layouts. "moved" moves the oven and the rack, starts the bakers at
// other points and walks around an obstacle. "wide" spreads the stations.
function handoffs(transform) {
  const result = {};
  for (const item of schedule.stations)
    result[item.id] = transform(item.id, item.handoff);
  return result;
}
const LAYOUTS = {
  "built-in": null,
  moved: {
    handoffs: handoffs((id, [x, y]) =>
      id === "bake" || id === "cool" ? [x + 1.6, y + 0.9] : [x, y],
    ),
    workerStarts: [
      [-5, 1.2],
      [-4.4, 1.2],
      [-3.8, 1.2],
    ],
    // An obstacle on the middle aisle: every walk goes around it at y = 1.8.
    routeBetween: (from, to) =>
      from[0] === to[0] && from[1] === to[1]
        ? [from, to]
        : [from, [from[0], 1.8], [to[0], 1.8], to],
  },
  wide: {
    handoffs: handoffs((_id, [x, y]) => [x * 1.7, y]),
  },
};

function settings() {
  const parsed = parseSettings({ ...sampleSettings(), workerCount: 2 });
  assert.equal(parsed.kind, "valid", JSON.stringify(parsed));
  return parsed.settings;
}

async function digest(value) {
  return sha256Hex(canonicalJson(value));
}

// Compile and schedule one layout. In module-state mode the layout reaches the
// module only through the setter; the extra arguments are then ignored.
async function compileFor(name) {
  const layout = LAYOUTS[name];
  if (mode === "module-state" && layout !== null)
    schedule.setScheduleSpatialLayout(layout);
  const input = settings();
  const resolved = schedule.resolveFinancierRun(input, "normal", layout);
  const scenario = await compileFinancier(resolved);
  const run = schedule.simulate(input, "normal", layout);
  const travel = [];
  for (const resource of scenario.resources)
    if (resource.kind === "worker")
      for (const leg of resource.travel)
        travel.push([resource.id, leg.from, leg.to, leg.duration]);
  return {
    scenario: await digest(scenario),
    revisions: scenario.workflows.map((workflow) => workflow.revision),
    travel: await digest(travel),
    walkSeconds: travelTotal(travel),
    carriesLayout: resolved.layout !== undefined,
    run: {
      kind: run.kind,
      end: run.end,
      intervals: await digest(run.intervals),
      lastDelivery: Math.max(...run.completions.map((item) => item.time)),
    },
  };
}

function travelTotal(travel) {
  let total = 0n;
  for (const leg of travel) total += BigInt(leg[3]);
  return total.toString();
}

function reference(name) {
  const stdout = execFileSync(
    process.execPath,
    [...process.execArgv, script, "--reference", name],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

if (process.argv[2] === "--reference") {
  const result = await compileFor(process.argv[3]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
if (process.argv[2] === "--order") {
  const results = [];
  for (const name of process.argv[3].split(","))
    results.push(await compileFor(name));
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exit(0);
}

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false, "Choose a fresh output directory");
mkdirSync(output, { recursive: true });

const names = Object.keys(LAYOUTS);
const references = {};
for (const name of names) references[name] = reference(name);

const problems = [];
// Each layout must change the result; else the journey proves nothing.
for (const [a, b] of [
  ["built-in", "moved"],
  ["built-in", "wide"],
  ["moved", "wide"],
]) {
  if (references[a].scenario === references[b].scenario)
    problems.push(`The compiled scenarios of ${a} and ${b} are equal`);
  if (references[a].run.intervals === references[b].run.intervals)
    problems.push(`The schedule runs of ${a} and ${b} are equal`);
  if (
    canonicalJson(references[a].revisions) ===
    canonicalJson(references[b].revisions)
  )
    problems.push(`The workflow revisions of ${a} and ${b} are equal`);
}
for (const name of names) {
  const expected = name !== "built-in";
  if (mode === "explicit" && references[name].carriesLayout !== expected)
    problems.push(
      `The resolved input of ${name} ${expected ? "does not carry" : "carries"} a layout`,
    );
}

const orders = [
  ["built-in", "moved"],
  ["moved", "built-in"],
  ["built-in", "wide"],
  ["wide", "built-in"],
  ["moved", "wide"],
  ["wide", "moved"],
];
const sequences = [];
for (const order of orders) {
  // Each order runs in its own process, so that no earlier order leaks into it.
  const stdout = execFileSync(
    process.execPath,
    [...process.execArgv, script, "--order", order.join(",")],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const results = JSON.parse(stdout.trim().split("\n").at(-1));
  const legs = [];
  for (const [index, name] of order.entries()) {
    const result = results[index];
    const same = canonicalJson(result) === canonicalJson(references[name]);
    let follows = null;
    if (!same)
      for (const other of names)
        if (canonicalJson(result) === canonicalJson(references[other]))
          follows = other;
    legs.push({ layout: name, sameAsReference: same, follows });
    if (!same)
      problems.push(
        `In the order ${order.join(" → ")}, the ${name} compile ${
          follows === null
            ? "differs from its reference"
            : `follows the ${follows} layout`
        }`,
      );
  }
  sequences.push({ order, legs });
}

if (mode !== "explicit")
  problems.push("The schedule module still exports setScheduleSpatialLayout");
const report = {
  journey: "schedule-layout",
  mode,
  setterExported: typeof schedule.setScheduleSpatialLayout === "function",
  getterExported: typeof schedule.getScheduleSpatialLayout === "function",
  references,
  sequences,
  problems,
  passed: problems.length === 0,
};
writeFileSync(
  resolve(output, "schedule-layout.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
for (const sequence of sequences)
  process.stdout.write(
    `${sequence.order.join(" → ")}: ${sequence.legs
      .map((leg) =>
        leg.sameAsReference
          ? `${leg.layout} ok`
          : `${leg.layout} ${leg.follows === null ? "differs" : `follows ${leg.follows}`}`,
      )
      .join(", ")}\n`,
  );
assert.deepEqual(problems, [], "Each compile depends only on its own layout");
process.stdout.write(`Schedule layout journey passed: ${output}\n`);
