// Plan 84 Journey J1: every recipe reaches the engine through one workflow
// document. Each document crosses the persistence boundary as JSON and lowers
// again. It must then run as its compiler's own scenario does, on real
// Rust/MuJoCo cells where the recipe has them.
//
//   node --experimental-strip-types scripts/production-simulation/verify-workflow-document-journey.mjs OUTPUT [--full]
//
// --full also runs the six-hour shift to its end. That leg takes many minutes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  importScenario,
  lowerWorkflowDocument,
  parseWorkflowDocument,
} from "../../packages/bakery-workflow/src/index.ts";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import { compileBakeryShift } from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import { sixHourShiftRecipeInput } from "../../packages/production-simulation/src/recipes/bakery/shift-preset.ts";
import {
  blackSesameRecipeInput,
  compileBlackSesameRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/black-sesame.ts";
import { compileCafeShift } from "../../packages/production-simulation/src/recipes/bakery/cafe-shift.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import {
  compileGingerBlackTeaRecipe,
  gingerBlackTeaRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-black-tea.ts";
import {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-milk-tea.ts";
import { compileLatte } from "../../packages/production-simulation/src/recipes/bakery/latte.ts";
import {
  compilePieRecipe,
  pieRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/pie.ts";
import { compileSiphon } from "../../packages/production-simulation/src/recipes/bakery/siphon.ts";
import { parseNativeCell } from "../../packages/production-simulation/src/native/cell-adapter.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import { defineCell, runtimeModule } from "./build-execution-bundle.mjs";

const full = process.argv.includes("--full");
const output = resolve(process.argv[2] ?? "");
assert.equal(existsSync(output), false, "Choose a fresh evidence directory");
mkdirSync(join(output, "documents"), { recursive: true });

const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
);
const E = await import(
  pathToFileURL(
    resolve(
      `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}/${manifest.engine.file}`,
    ),
  ).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}

const preparation = await runtimeModule(runtime);
const rackCell = (id) => defineCell(preparation, id);
const panCell = () =>
  defineCell(preparation, "tea-pan-cell", { fixture: "pan-staging" });
const espressoCell = () =>
  defineCell(preparation, "espresso-cell", {
    fixture: "espresso",
    appliance: "linea",
  });

/** Drive to the end. Each review takes the outcome that `decide` gives. */
async function run(scenario, cells, leg, decide) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells,
    identity: {
      runId: "workflow-document-journey",
      executionId: `document-${leg}`,
      hostSession: `host-${leg}`,
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));
  const until = scenario.limits.horizon;
  let reviews = 0;
  for (let turn = 0; turn < 20_000; turn++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    const status = reply.view.status.kind;
    if (status === "awaiting-inspection") {
      const pending = reply.view.inspections.find(isPending);
      assert.ok(pending);
      const answer = await host.handle({
        kind: "inspect",
        commandId: `review-${reviews++}`,
        expectedControlRevision: reply.view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome: decide(pending.task),
        note: "Plan 84 document journey",
      });
      assert.equal(answer.receipt.status, "accepted", JSON.stringify(answer));
      continue;
    }
    if (["completed", "blocked", "stopped-at-limit"].includes(status)) {
      const state = await host.handle({ kind: "state" });
      await host.handle({ kind: "dispose" });
      return state.run;
    }
  }
  throw new Error(`${leg} exceeded its execution bound`);
}
function isPending(item) {
  return item.kind === "pending";
}
function accept() {
  return "accept";
}

/** Everything a person can see of a run, without the identity of its host. */
async function outcome(run) {
  const events = [];
  for (const event of run.events) {
    const { execution: _execution, ...rest } = event;
    events.push(rest);
  }
  return {
    status: run.status.kind,
    time: run.time,
    events: events.length,
    eventDigest: await sha256Hex(canonicalJson(events)),
  };
}

const recipes = [
  {
    id: "latte",
    title: "Latte",
    compile: () => compileLatte({ revision: 1, milkG: 180 }),
    run: true,
  },
  {
    id: "siphon",
    title: "Siphon coffee",
    compile: () =>
      compileSiphon({
        revision: 1,
        waterG: 300,
        coffeeG: 20,
        steepSeconds: 60,
      }),
    run: true,
  },
  {
    id: "pie",
    title: "Pie",
    compile: async () => value(await compilePieRecipe(pieRecipeInput())),
    run: true,
  },
  {
    id: "black-sesame",
    title: "Black sesame milk",
    cell: rackCell("sesame-cold-cell"),
    compile: async (cell) =>
      value(await compileBlackSesameRecipe(blackSesameRecipeInput(), cell)),
    run: true,
  },
  {
    id: "financier",
    title: "Hazelnut financier",
    cell: rackCell("financier-cold-cell"),
    compile: async (cell) =>
      value(
        await compileFinancierRecipe(financierRecipeInput(1, 2, 900), cell),
      ),
    run: true,
  },
  {
    id: "ginger-black-tea",
    title: "Ginger black tea",
    cell: panCell(),
    compile: async (cell) =>
      value(
        await compileGingerBlackTeaRecipe(gingerBlackTeaRecipeInput(), cell),
      ),
    run: true,
  },
  {
    id: "ginger-milk-tea",
    title: "Ginger milk tea",
    cell: panCell(),
    compile: async (cell) =>
      value(await compileGingerMilkTeaRecipe(gingerMilkTeaRecipeInput(), cell)),
    run: true,
  },
  {
    id: "cafe-shift",
    title: "Café shift",
    cell: espressoCell(),
    compile: async (cell) =>
      compileCafeShift(
        {
          espresso: { revision: 1, orders: 2, appliance: "linea" },
          financierLoads: 1,
        },
        value(parseNativeCell(cell)),
      ),
    run: true,
  },
  {
    id: "six-hour-shift",
    title: "Six-hour shift",
    cell: panCell(),
    compile: async (cell) =>
      value(await compileBakeryShift(sixHourShiftRecipeInput(), cell)),
    run: full,
  },
];

const results = [];
const documents = new Map();
for (const recipe of recipes) {
  const started = Date.now();
  const scenario = await recipe.compile(recipe.cell);
  const compiled = value(await E.admitScenario(scenario));
  const document = importScenario(scenario, {
    title: recipe.title,
    recipe: recipe.id,
  });
  // Cross the persistence boundary, as a stored revision does.
  const wire = JSON.parse(JSON.stringify(document));
  const parsed = value(parseWorkflowDocument(wire));
  documents.set(recipe.id, parsed);
  const lowered = lowerWorkflowDocument(parsed);
  const admitted = value(await E.admitScenario(lowered));
  assert.equal(
    admitted.digest,
    compiled.digest,
    `${recipe.id}: digest changed`,
  );
  writeFileSync(
    join(output, "documents", `${recipe.id}.json`),
    `${canonicalJson(parsed)}\n`,
  );
  const entry = {
    recipe: recipe.id,
    digest: compiled.digest,
    workflows: parsed.workflows.length,
    nodes: parsed.workflows.reduce(sumNodes, 0),
    edges: parsed.workflows.reduce(sumEdges, 0),
    native: scenario.cells.length,
    bytes: JSON.stringify(parsed).length,
  };
  if (recipe.run) {
    const cells = recipe.cell === undefined ? [] : [recipe.cell];
    const fromCompiler = await outcome(
      await run(scenario, cells, `${recipe.id}-compiler`, accept),
    );
    const fromDocument = await outcome(
      await run(lowered, cells, `${recipe.id}-document`, accept),
    );
    assert.deepEqual(fromDocument, fromCompiler, `${recipe.id}: run changed`);
    assert.equal(fromDocument.status, "completed", recipe.id);
    entry.run = fromDocument;
  }
  entry.seconds = (Date.now() - started) / 1000;
  results.push(entry);
  console.log(JSON.stringify(entry));
}
function sumNodes(total, workflow) {
  return total + workflow.nodes.length;
}
function sumEdges(total, workflow) {
  return total + workflow.edges.length;
}

// The latte's prerequisites decide its execution: its two arms overlap.
const latte = await run(
  await compileLatte({ revision: 1, milkG: 180 }),
  [],
  "latte-arms",
  accept,
);
function moment(run, kind, key) {
  for (const event of run.events)
    if (event.kind === kind && event.task.endsWith(`/${key}`))
      return event.time;
  throw new Error(`Missing ${kind} of ${key}`);
}
assert.ok(
  moment(latte, "task-started", "steam-stretch") <
    moment(latte, "task-completed", "espresso-shot"),
  "The steamed milk did not overlap the shot.",
);
for (const before of ["transfer-cup", "steam-whirlpool"])
  assert.ok(
    moment(latte, "task-started", "pour-latte") >=
      moment(latte, "task-completed", before),
    `The pour started before ${before} finished.`,
  );

// A rejected tray takes its other arm, and the join still runs.
const tea = documents.get("ginger-milk-tea");
const rejected = await run(
  lowerWorkflowDocument(tea),
  [recipes.find(isGingerMilk).cell],
  "tea-reject",
  reject,
);
assert.equal(rejected.status.kind, "completed");
assert.ok(rejected.events.some(isSkip), "A rejected review skipped no task.");
function isGingerMilk(recipe) {
  return recipe.id === "ginger-milk-tea";
}
function reject() {
  return "reject";
}
function isSkip(event) {
  return event.kind === "task-skipped";
}

// Faults in a document reach a person as refusals, and nothing runs.
function withWorkflow(document, change) {
  const [first, ...rest] = document.workflows;
  return { ...document, workflows: [change(first), ...rest] };
}
const base = documents.get("latte");
const refusals = {};

const cyclic = withWorkflow(base, (graph) => ({
  ...graph,
  edges: [
    ...graph.edges,
    { from: "return-pitcher", to: "place-cup", branch: null },
  ],
}));
const cycle = await E.admitScenario(lowerWorkflowDocument(cyclic));
assert.equal(cycle.ok, false);
refusals.cycle = cycle.error.map(problemCode);
assert.ok(refusals.cycle.includes("cyclic_tasks"));

const missingWorker = withWorkflow(base, (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.id === "pour-latte"
      ? {
          ...node,
          body: {
            ...node.body,
            executor: { ...node.body.executor, workers: ["nobody"] },
          },
        }
      : node,
  ),
}));
const worker = await E.admitScenario(lowerWorkflowDocument(missingWorker));
assert.equal(worker.ok, false);
refusals.unknownWorker = worker.error.map(problemCode);
assert.ok(refusals.unknownWorker.includes("unknown_reference"));

const brokenBody = JSON.parse(JSON.stringify(base));
brokenBody.workflows[0].nodes[0].body.executor = { kind: "teleport" };
const body = parseWorkflowDocument(brokenBody);
assert.equal(body.ok, false);
refusals.brokenBody = body.error.code;

const wrongBranch = JSON.parse(JSON.stringify(tea));
for (const graph of wrongBranch.workflows)
  for (const edge of graph.edges)
    if (edge.branch === "accept") edge.branch = "reject";
const branch = parseWorkflowDocument(wrongBranch);
assert.equal(branch.ok, false, "A swapped branch edge was accepted.");
refusals.swappedBranch = branch.error.code;

function problemCode(problem) {
  return problem.code;
}

writeFileSync(
  join(output, "report.json"),
  `${canonicalJson({
    executionBundle: manifest.bundle.id,
    fullShiftRun: full,
    results,
    latteArms: {
      steamStarted: moment(latte, "task-started", "steam-stretch"),
      shotCompleted: moment(latte, "task-completed", "espresso-shot"),
      pourStarted: moment(latte, "task-started", "pour-latte"),
      end: latte.time,
    },
    rejectedTea: {
      status: rejected.status.kind,
      skipped: rejected.events.filter(isSkip).map(skipTask),
    },
    refusals,
  })}\n`,
);
function skipTask(event) {
  return event.task;
}
console.log(`J1 passed. Evidence: ${output}`);
