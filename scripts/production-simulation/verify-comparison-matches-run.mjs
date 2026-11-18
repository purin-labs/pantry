// Refactor 16 step 5: the robot comparison and a production run give the
// same result for one transfer.
//
//   node scripts/production-simulation/verify-comparison-matches-run.mjs NEW_OUTPUT_DIRECTORY
//     [--runtime BUNDLE_DIRECTORY]
//
// One Wasm runtime serves both, as one Portal engine worker does:
//  1. The production engine of the current source runs the one-cell
//     scenario of Plan 70 J1/J2. The journey records every segment of the
//     cell's first operation, a table-to-rack transfer of the FR10.
//  2. The robot comparison's program runs the same transfer: FR10, table to
//     rack, nominal, 1 kg at the tray center.
//  3. Both must give the same outcome, events and samples. A run cuts its
//     recording at other steps than the comparison, so the samples are
//     compared by step; every step that both recorded must be equal. The
//     outcome holds the margins against the robot's rated limits (Refactor
//     16 step 7), so the comparison shows the margins of the run's transfer.
//  4. For contrast, the one-shot transfer (the comparison before this step)
//     starts from the fixture's prepared pose. Its result differs, and the
//     report gives by how much.
// The report goes to OUTPUT/report.json.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { phase1Scenario, runToEnd } from "./phase-1-scenarios.mjs";
import { assertAcceptedMargins } from "./operation-margins.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
let output = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else if (output === null) output = resolve(args[index]);
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(
  output !== null && !existsSync(output),
  "Name a new output directory",
);
mkdirSync(output, { recursive: true });

const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};
const module = await runtimeModule(runtime);
const text = E.wasmTextTransport(module, codec);
const plain = E.parsedTransport(text);

// 1. The production run, with each operation's segments by attempt.
const operations = new Map();
const recording = {
  async send(command) {
    const reply = await plain.send(command);
    if (command.op === "start" && reply.kind === "started")
      operations.set(reply.attemptId, {
        cell: command.cell,
        task: command.task,
        segments: [],
        outcome: null,
      });
    if (command.op === "advance" && reply.kind === "advanced" && reply.segment)
      for (const operation of operations.values())
        if (
          operation.outcome === null &&
          operation.cell === command.cell &&
          reply.segment.attemptId !== undefined
        ) {
          operation.segments.push(reply.segment);
          if (reply.outcome) operation.outcome = reply.outcome;
        }
    return reply;
  },
};
const scenario = await phase1Scenario(E, runtime, "one-cell");
await runToEnd(E, recording, built.manifest.bundle, scenario, "comparison");
const [attemptId, first] = [...operations.entries()][0];
assert.equal(first.task, "table-to-rack");
assert.ok(first.outcome !== null, "The first transfer ended");
assert.ok(
  first.segments.every((segment) => segment.attemptId === attemptId),
  "The segments belong to the first transfer",
);

// 2. The comparison and 4. the one-shot transfer, as host programs.
function program(command) {
  const reply = JSON.parse(
    E.exchangeNow(module, codec, JSON.stringify({ op: "program", command })),
  );
  assert.equal(reply.kind, "program", JSON.stringify(reply).slice(0, 400));
  return reply.reply;
}
function runProgram(job, value) {
  let reply = program({ op: "open", job, program: value });
  while (reply.kind === "running")
    reply = program({ op: "advance", job, steps: 2000 });
  assert.equal(reply.kind, "finished", JSON.stringify(reply).slice(0, 400));
  return JSON.parse(reply.output);
}
const comparison = runProgram("comparison", {
  kind: "comparison",
  robot: "fairino-fr10",
  task: "table-to-rack",
  case: "nominal",
  ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
});
const { request } = program({ op: "prepare", preparation: {} });
const oneShot = runProgram("one-shot", { kind: "run", request });

// 3. Equal outcome, events and samples by step.
function byStep(samples) {
  const steps = new Map();
  for (const sample of samples) steps.set(sample.step, JSON.stringify(sample));
  return steps;
}
const runSamples = byStep(first.segments.flatMap((segment) => segment.samples));
const runEvents = first.segments.flatMap((segment) => segment.events);
function compare(label, recordingFile) {
  const samples = byStep(recordingFile.samples);
  let common = 0;
  let equal = 0;
  let largestTrayMm = 0;
  for (const [step, sample] of samples) {
    const other = runSamples.get(step);
    if (other === undefined) continue;
    common += 1;
    if (other === sample) equal += 1;
    const a = JSON.parse(sample).tray;
    const b = JSON.parse(other).tray;
    largestTrayMm = Math.max(
      largestTrayMm,
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000,
    );
  }
  return {
    label,
    outcome: recordingFile.outcome,
    sameOutcome:
      JSON.stringify(recordingFile.outcome) === JSON.stringify(first.outcome),
    sameEvents:
      JSON.stringify(
        recordingFile.events.map(({ step, kind }) => [step, kind]),
      ) === JSON.stringify(runEvents.map((event) => [event.step, event.kind])),
    commonSteps: common,
    equalSteps: equal,
    largestTrayDifferenceMm: largestTrayMm,
  };
}
const matched = compare("robot comparison", comparison);
const contrast = compare("one-shot transfer (before step 5)", oneShot);
const report = {
  runtime: BAKERY_BROWSER_BUNDLE.id,
  run: {
    attemptId,
    outcome: first.outcome,
    margins: assertAcceptedMargins(first.outcome, [], "the run's transfer"),
    segments: first.segments.length,
    samples: runSamples.size,
  },
  comparison: matched,
  oneShot: contrast,
};
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    { run: report.run, comparison: matched, oneShot: contrast },
    null,
    2,
  ),
);

assert.ok(matched.sameOutcome, "The comparison and the run end alike");
assert.ok(
  matched.sameEvents,
  "The comparison and the run record the same events",
);
assert.ok(
  matched.commonSteps > 400,
  "The two recordings share their sampled steps",
);
assert.equal(
  matched.equalSteps,
  matched.commonSteps,
  "Every shared step is equal",
);
assert.ok(!contrast.sameOutcome, "The one-shot transfer differs from the run");
console.log(
  "pass: the robot comparison and the production run give the same transfer",
);
