// Two carriers traverse loading, a physical wait, retrieval and racking.
// Every interrupted segment restores in a fresh native process or Wasm module.
//
// Refactor 16 step 7: each operation reports its margins against the UR5e's
// rated limits. Each joint stays below its rated speed. The retrieval warns:
// its right clamp pad presses about 1.1 mm into the tray's side wall. An
// operation that pauses and resumes in a fresh process reports the same
// margins as the uninterrupted one.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  OVEN_CELL,
  SPANNER_OVEN_CELL,
  defineCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { NativeHost, WasmHost, cellRequest } from "./engine-hosts.mjs";
import { assertAcceptedMargins } from "./operation-margins.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const binary = resolve(
  process.env.BAKERY_NATIVE_BINARY ??
    "crates/bakery-native/target/release/bakery-native",
);
const runtime = process.env.PLAN_70_BROWSER_BUNDLE;
const fixtureName = process.env.PLAN_70_OVEN_FIXTURE ?? OVEN_CELL.fixture;
const cellSpec =
  fixtureName === "spanner-oven-rack"
    ? {
        ...SPANNER_OVEN_CELL,
        robot: process.env.PLAN_70_OVEN_ROBOT ?? SPANNER_OVEN_CELL.robot,
      }
    : {
        ...OVEN_CELL,
        robot: process.env.PLAN_70_OVEN_ROBOT ?? OVEN_CELL.robot,
      };
const isSpanner = cellSpec.fixture === "spanner-oven-rack";
let sequence = 0;

/** A new native `serve` process or a new Wasm module: nothing carries over. */
async function freshHost() {
  if (runtime !== undefined)
    return new WasmHost(await runtimeModule(resolve(runtime)));
  const directory = join(output, `host-${sequence}`);
  mkdirSync(directory);
  return new NativeHost(resolve("."), binary, directory);
}

// Refactor 16 step 11: each request runs through the host commands, which
// the Portal's engine worker also uses (engine-hosts.mjs, `cellRequest`).
async function cell(name, initial, actions, reject = false) {
  const filename = `${++sequence}-${name}.json`;
  writeFileSync(
    join(output, `${sequence}-${name}-request.json`),
    JSON.stringify({ initial, actions }),
  );
  const host = await freshHost();
  let result;
  let refusal = null;
  try {
    result = await cellRequest(host, { initial, actions });
  } catch (error) {
    refusal = { result: "rejected", detail: String(error.message) };
  } finally {
    await host.close();
  }
  if (reject) {
    assert.notEqual(refusal, null, `${name} must be refused`);
    writeFileSync(join(output, filename), JSON.stringify(refusal));
    return refusal;
  }
  assert.equal(refusal, null, JSON.stringify(refusal));
  writeFileSync(join(output, filename), JSON.stringify(result));
  return result;
}
function after(result) {
  return {
    kind: "continue",
    content: result.stored.content,
    digest: result.stored.digest,
    sequence: result.sequence,
  };
}
function start(task, attemptId) {
  return { kind: "start", task, attemptId };
}
/** The margins of each attempt, by its identity. */
const margins = new Map();
function completed(result) {
  for (const outcome of result.results) {
    if (outcome.kind === "refused") assert.fail(JSON.stringify(outcome));
    if (outcome.kind === "terminal") {
      assert.equal(outcome.outcome.kind, "completed", JSON.stringify(outcome));
      const id = outcome.attemptId;
      assertAcceptedMargins(
        outcome.outcome,
        !isSpanner && id.endsWith("-retrieve") ? ["penetration"] : [],
        id,
      );
      // The second run of an attempt pauses and resumes in a new process.
      if (margins.has(id))
        assert.deepEqual(outcome.outcome.margins, margins.get(id), id);
      else margins.set(id, outcome.outcome.margins);
    }
  }
  assert.equal(result.hold, null, "The combined fixture has no qualified hold");
}
const definitionHost = await freshHost();
const definition =
  runtime === undefined
    ? (
        await definitionHost.send({
          op: "define",
          definition: { ...cellSpec, cell: "cold-cell-1" },
        })
      ).definition
    : defineCell(definitionHost.module, "cold-cell-1", cellSpec);
await definitionHost.close();
writeFileSync(join(output, "0-definition.json"), JSON.stringify(definition));
// The uninterrupted reference runs each carrier's three operations in one
// call. One call for both carriers records six dense segments, about 152 MiB:
// above the native 128 MiB cell limit, and more than the Wasm module can
// encode. The empty cell between the carriers is the only boundary.
let baseline = null;
for (const carrier of ["tray-a", "tray-b"]) {
  baseline = await cell(
    `${carrier}-baseline`,
    baseline === null ? { kind: "create", definition } : after(baseline),
    [
      { kind: "admit", carrier },
      start("table-to-oven", `${carrier}-load`),
      { kind: "finish" },
      { kind: "advance", steps: 2500 },
      start("oven-to-table", `${carrier}-retrieve`),
      { kind: "finish" },
      start("table-to-rack", `${carrier}-rack`),
      { kind: "finish" },
      { kind: "remove", carrier },
    ],
  );
  completed(baseline);
}
let current = null;
let restores = 0;
for (const carrier of ["tray-a", "tray-b"]) {
  current = await cell(
    `${carrier}-admit`,
    current === null ? { kind: "create", definition } : after(current),
    [{ kind: "admit", carrier }],
  );
  await cell(
    `${carrier}-refuse-early-retrieval`,
    after(current),
    [start("oven-to-table", "invalid-retrieve")],
    true,
  );
  for (const [task, suffix, location] of [
    ["table-to-oven", "load", "oven"],
    ["oven-to-table", "retrieve", "returned"],
    ["table-to-rack", "rack", "rack"],
  ]) {
    const before = current.observation;
    current = await cell(`${carrier}-${suffix}-start`, after(current), [
      start(task, `${carrier}-${suffix}`),
    ]);
    completed(current);
    assert.deepEqual(
      current.observation,
      before,
      "Dispatch cannot reposition a body",
    );
    current = await cell(`${carrier}-${suffix}-pause`, after(current), [
      { kind: "advance", steps: 1000 },
    ]);
    assert.ok(
      current.checkpoint.operation,
      "The pause must interrupt physical motion",
    );
    current = await cell(`${carrier}-${suffix}-finish`, after(current), [
      { kind: "finish" },
    ]);
    restores++;
    completed(current);
    assert.equal(current.checkpoint.slot.location, location);
    if (task === "table-to-oven") {
      await cell(
        `${carrier}-refuse-duplicate-loading`,
        after(current),
        [start("table-to-oven", "invalid-load")],
        true,
      );
      await cell(
        `${carrier}-refuse-rack-before-retrieval`,
        after(current),
        [start("table-to-rack", "invalid-rack")],
        true,
      );
      current = await cell(`${carrier}-wait`, after(current), [
        { kind: "advance", steps: 2500 },
      ]);
      completed(current);
    }
  }
  current = await cell(`${carrier}-remove`, after(current), [
    { kind: "remove", carrier },
  ]);
}
assert.deepEqual(current.checkpoint, baseline.checkpoint);
assert.deepEqual(current.observation, baseline.observation);
assert.equal(current.checkpoint.slot.generation, 2);
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    {
      result: "passed",
      backend: runtime === undefined ? "native" : "wasm",
      restores,
      margins: Object.fromEntries(margins),
      steps: current.checkpoint.steps,
      seconds: current.checkpoint.steps * 0.002,
      checkpoint: current.checkpoint.digest,
      definition,
    },
    null,
    2,
  ),
);
console.log(`Persistent oven cell passed: ${output}`);
