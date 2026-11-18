import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePhysicsRequest,
  parsePhysicsReplay,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import { sampleSettings } from "../../packages/bakery-model/src/bakery.ts";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot.ts";
import { compileWorkcellInput } from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  acceptProductionRecording,
  bindProductionSuccessor,
  compileRehearsalWorkcells,
  editRehearsalWorkcells,
  exportRehearsalWorkcells,
  parseRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { parseNativeContinuation } from "../../packages/production-simulation/src/recipes/bakery/native-continuation.ts";
import { productionMaterialAt } from "../../packages/production-simulation/src/recipes/bakery/production-material.ts";
import { rehearsalSettings } from "../../packages/production-simulation/src/simulator/rehearsal-presets.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";
import { physicsDuration } from "../../packages/production-simulation/src/recipes/bakery/physics-playback.ts";

// Plan 42 authored continuation, on the production scheduler (Plan 42F F1d).
// The native simulator runs loading, retrieval and racking; each result is
// accepted into one rehearsal tray chain and its successor bound from the
// handoff the native run wrote.
const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
if (process.argv.length !== 4)
  throw new Error("Provide a new acceptance directory and robot ID.");
const output = resolve(process.argv[2]);
const robot = process.argv[3];
if (existsSync(output)) throw new Error("Choose a new acceptance directory.");
mkdirSync(output, { recursive: true });

function execute(name, args) {
  const path = join(output, name);
  execFileSync(binary, ["--output", path, ...args], {
    cwd: root,
    timeout: 150000,
  });
  return path;
}
function read(path) {
  return readFileSync(path, "utf8");
}
function ready(result) {
  assert.equal(result.kind, "ready", result.message);
  return result.plan;
}
function native(plan, id) {
  const task = simulateProduction(plan).intervals.find(
    (interval) => interval.kind === "native" && interval.operation.id === id,
  );
  assert.ok(task, `Missing native task ${id}`);
  return task;
}
function operation(plan, id) {
  const found = plan.operations.find((item) => item.id === id);
  assert.ok(found, `Missing operation ${id}`);
  return found;
}
async function roundtrip(plan, name) {
  const file = exportRehearsalWorkcells(plan);
  writeFileSync(join(output, name), file);
  assert.ok(
    parseRunSnapshot({
      name: "Authored continuity",
      document: JSON.parse(file),
    }),
  );
  const restored = ready(await parseRehearsalWorkcells(file));
  assert.equal(restored.fingerprint, plan.fingerprint);
  assert.deepEqual(
    simulateProduction(restored).intervals.map(span),
    simulateProduction(plan).intervals.map(span),
  );
  return restored;
}
function span(interval) {
  return [interval.kind, interval.batch, interval.start, interval.end];
}
function replay(path) {
  const parsed = parsePhysicsReplay(read(path));
  assert.equal(parsed.kind, "accepted", parsed.message);
  const invalidLoads = [
    { massKg: -1, forwardMm: 0, lateralMm: 0 },
    { massKg: 4.1, forwardMm: 0, lateralMm: 0 },
    { massKg: 1, forwardMm: 100.5, lateralMm: 0 },
    { massKg: 1, forwardMm: 0, lateralMm: 61 },
    { massKg: 1, forwardMm: 0 },
  ];
  for (const [index, ingredients] of invalidLoads.entries()) {
    const raw = { ...JSON.parse(read(requestPath)), ingredients };
    const file = join(output, `invalid-load-${index}.json`);
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(parsePhysicsRequest(JSON.stringify(raw)).kind, "rejected");
    assert.throws(
      execute.bind(null, `invalid-result-${index}.json`, ["run", file]),
    );
  }

  return parsed.recording;
}
async function accept(plan, id, recording, handoff = null) {
  const accepted = ready(
    acceptProductionRecording(plan, plan.fingerprint, id, recording, handoff),
  );
  return ready(await bindProductionSuccessor(accepted, id));
}

const settings = rehearsalSettings(sampleSettings());
const requestPath = execute("request.json", [
  "prepare",
  "--robot",
  robot,
  "--task",
  "table-to-oven",
  "--cell",
  "combined",
  "--ingredient-mass-kg",
  "0.75",
  "--ingredient-forward-mm",
  "-100",
  "--ingredient-lateral-mm",
  "60",
]);
const parsed = parsePhysicsRequest(read(requestPath));
assert.equal(parsed.kind, "accepted", parsed.message);
const input = compileWorkcellInput(parsed.request, "0", "cold-cell-1");
assert.equal(input.kind, "ready", input.message);
const load = "batch:A:native:1";
const unload = `${load}:2`;
const rack = `${load}:3`;
function chain(rackCase) {
  return {
    batchId: "A",
    workerId: "human-1",
    dependsOn: [],
    earliestStartSeconds: 30,
    input: input.input,
    successors: [
      { skill: { kind: "unload" }, earliestStartSeconds: 120 },
      { skill: { kind: "rack", rackCase }, earliestStartSeconds: 220 },
    ],
  };
}
let plan = ready(await compileRehearsalWorkcells(settings, [chain("nominal")]));
plan = await roundtrip(plan, "before-loading.json");
assert.deepEqual(
  plan.planned.map((step) => [step.id, step.skill.kind]),
  [
    [unload, "unload"],
    [rack, "rack"],
  ],
);
// Planned steps have no request, so no result can be accepted for them.
assert.equal(
  acceptProductionRecording(
    plan,
    plan.fingerprint,
    unload,
    parseNativeContinuation(
      read(execute("unused-loading.json", ["load", requestPath])),
    ).predecessor,
  ).kind,
  "rejected",
);
assert.deepEqual(
  simulateProduction(plan).nativeHolds.map((hold) => hold.operation.id),
  [load],
);

const loadingPath = execute("loading.json", ["load", requestPath]);
const loading = parseNativeContinuation(read(loadingPath));
// Binding needs the accepted predecessor; a handoff alone is not enough.
assert.equal((await bindProductionSuccessor(plan, load)).kind, "rejected");
plan = await accept(plan, load, loading.predecessor, loading);
assert.equal(operation(plan, unload).start.kind, "continuation");
assert.equal(
  simulateProduction(plan).nativeHolds.find(
    (hold) => hold.operation.id === unload,
  ).start,
  120,
);
const handoffs = simulateProduction(plan).intervals.filter(
  (interval) => interval.kind === "handoff",
);
assert.deepEqual(
  handoffs.map((handoff) => handoff.phase),
  ["stage"],
  "the chain stages once and holds the cell until clearance",
);
plan = await roundtrip(plan, "awaiting-retrieval.json");
const restoredLoadingPath = join(output, "restored-loading.json");
writeFileSync(restoredLoadingPath, operation(plan, load).handoff.file);
const retrievalPath = execute("retrieval.json", [
  "unload",
  restoredLoadingPath,
  "--for-rack",
]);
const retrieval = parseNativeContinuation(read(retrievalPath));
plan = await accept(plan, unload, retrieval.predecessor, retrieval);
const retrieved = native(plan, unload);
assert.equal(retrieved.start, 120);
assert.equal(
  retrieved.end - retrieved.start,
  physicsDuration(retrieval.predecessor) - physicsDuration(loading.predecessor),
);
const beforeRack = plan;
plan = await roundtrip(plan, "awaiting-racking.json");
const restoredRetrievalPath = join(output, "restored-retrieval.json");
writeFileSync(restoredRetrievalPath, operation(plan, unload).handoff.file);
const rackPath = execute("racking.json", ["rack", restoredRetrievalPath]);
const completedRecording = replay(rackPath);
plan = await accept(plan, rack, completedRecording);
const racked = native(plan, rack);
assert.equal(racked.start, 220);
assert.equal(
  racked.end - racked.start,
  physicsDuration(completedRecording) - physicsDuration(retrieval.predecessor),
);
const completedRun = simulateProduction(plan);
assert.equal(completedRun.kind, "complete");
assert.deepEqual(
  completedRun.intervals
    .filter((interval) => interval.kind === "handoff")
    .map((handoff) => handoff.phase),
  ["stage", "clear"],
);
assert.equal(
  productionMaterialAt(completedRun, operation(plan, rack), racked.start + 1)
    .kind,
  "transferring",
);
assert.equal(
  productionMaterialAt(completedRun, operation(plan, load), 200).kind,
  "awaiting-evidence",
);
plan = await roundtrip(plan, "completed.json");

// A result must retain its exact accepted predecessor.
const altered = JSON.parse(JSON.stringify(completedRecording));
altered.loading.events[0].label = "different accepted history";
const parsedAltered = parsePhysicsReplay(JSON.stringify(altered));
assert.equal(parsedAltered.kind, "accepted", parsedAltered.message);
assert.equal(
  acceptProductionRecording(
    beforeRack,
    beforeRack.fingerprint,
    rack,
    parsedAltered.recording,
  ).kind,
  "rejected",
);
const otherRequestPath = execute("other-request.json", [
  "prepare",
  "--robot",
  robot,
  "--clamp-force-n",
  "90",
  "--task",
  "table-to-oven",
  "--cell",
  "combined",
]);
const otherLoading = parseNativeContinuation(
  read(execute("other-loading.json", ["load", otherRequestPath])),
);
const fresh = ready(
  await compileRehearsalWorkcells(settings, [chain("nominal")]),
);
assert.equal(
  acceptProductionRecording(
    fresh,
    fresh.fingerprint,
    load,
    otherLoading.predecessor,
    otherLoading,
  ).kind,
  "rejected",
);

// A slip holds the cell; an independent tray cannot stage after reopening.
let failed = ready(await compileRehearsalWorkcells(settings, [chain("slip")]));
failed = await accept(failed, load, loading.predecessor, loading);
failed = await accept(failed, unload, retrieval.predecessor, retrieval);
const slipPath = execute("slip.json", [
  "rack",
  restoredRetrievalPath,
  "--case",
  "slip",
]);
failed = await accept(failed, rack, replay(slipPath));
const independentRequestPath = execute("independent-request.json", [
  "prepare",
  "--robot",
  robot,
]);
const independent = parsePhysicsRequest(read(independentRequestPath));
assert.equal(independent.kind, "accepted");
const independentInput = compileWorkcellInput(
  independent.request,
  "0",
  "cold-cell-1",
);
assert.equal(independentInput.kind, "ready");
failed = ready(
  await editRehearsalWorkcells(failed, {
    kind: "add",
    workerId: "human-1",
    input: independentInput.input,
    successors: [],
  }),
);
// Tray B is queued after A's slip, so it finds A holding the cell.
failed = ready(
  await editRehearsalWorkcells(failed, {
    kind: "start",
    operationId: "batch:B:native:1",
    earliestStartSeconds: 300,
  }),
);
failed = await roundtrip(failed, "failed.json");
assert.equal(operation(failed, rack).attempt.kind, "recovery-required");
const failedRun = simulateProduction(failed);
assert.equal(failedRun.kind, "blocked");
assert.ok(
  failedRun.unresolvedWaits.some(
    (wait) =>
      wait.batch === "B" &&
      wait.label === `Workcell resources reserved by ${load}`,
  ),
);

// Corrupted full integration state is rejected by the native resume boundary.
const corrupt = JSON.parse(read(restoredRetrievalPath));
corrupt.handoff.digest = "0".repeat(64);
const corruptPath = join(output, "corrupt-handoff.json");
writeFileSync(corruptPath, JSON.stringify(corrupt));
assert.throws(runCorrupt);
assert.equal(existsSync(join(output, "corrupt-output.json")), false);
function runCorrupt() {
  execute("corrupt-output.json", ["rack", corruptPath]);
}
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      robot,
      nativeBinary: binary,
      checks: [
        "full chain authored and reopened before execution",
        "planned steps reject results before their predecessor",
        "binding requires the accepted predecessor and its handoff",
        "request-first loading",
        "authored start constraints",
        "one staging and one clearance for the chain",
        "loading and retrieval save and reopen with their handoffs",
        "successor durations counted once",
        "tray custody follows the chain",
        "exact-prefix rejection",
        "another loading result is rejected",
        "slip holds the cell and blocks the next tray after reopening",
        "native rejects a corrupt handoff",
      ],
      completedSchedule: completedRun.intervals.map(span),
      failedSchedule: failedRun.intervals.map(span),
    },
    null,
    2,
  ),
);
process.stdout.write(`Acceptance passed: ${join(output, "report.json")}\n`);
