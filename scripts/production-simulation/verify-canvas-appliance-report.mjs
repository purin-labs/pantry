/**
 * Refactor 16, Step 15 verification journey:
 * 1. Verifies the remaining standalone recipe families (Pie, Espresso Linea &
 *    Eagle One, Pour-Over) through the single data-driven table
 *    (`recipeApplianceTasks` + `executeRecipeApplianceTasks`), completing
 *    verification across all seven recipe families alongside
 *    `verify-recipe-appliance-wasm.mjs`.
 * 2. Edits a real Financier recipe on the Plan 84 workflow canvas (`draftSeed`,
 *    `withStepSeconds`, `newStepNode`, `compileDraft`), runs the lowered
 *    scenario in the pinned Wasm execution host, and verifies its real MuJoCo
 *    appliance physics report — including the canvas-added duplicate bake step
 *    (`bake-2`) and at-risk marking of the middle-rear hotspot bake without
 *    failing the completed schedule task (D3).
 * 3. Compiles and runs a custom canvas workflow (non-built-in workflow id)
 *    using canonical task kinds and verifies its real MuJoCo appliance report.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  importScenario,
  workflowApplianceTaskKinds,
} from "../../packages/bakery-workflow/src/index.ts";
import {
  compileDraft,
  draftSeed,
  newStepNode,
  withStepSeconds,
} from "../../packages/bakery-workflow/src/draft.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import {
  compilePieRecipe,
  pieRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/pie.ts";
import { compileEspresso } from "../../packages/production-simulation/src/recipes/bakery/espresso.ts";
import { compilePourOverShiftWorkflow } from "../../packages/production-simulation/src/recipes/bakery/pour-over.ts";
import {
  atRiskTasksFromApplianceReport,
  evaluatePendingInspectionGate,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
} from "../../packages/production-simulation/src/recipes/bakery/appliance-execution.ts";
import { recipeApplianceTasks } from "../../packages/production-simulation/src/recipes/bakery/appliance-task-table.ts";
import { parseNativeCell } from "../../packages/production-simulation/src/native/cell-adapter.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { defineCell, runtimeModule } from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

const output = resolve(
  process.argv[2] ?? "output/refactor-16-step-15-canvas-appliance",
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const engineDirectory = resolve(
  `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}`,
);
const runtimeDir = resolve(
  `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
);
const E = await import(
  pathToFileURL(join(engineDirectory, manifest.engine.file)).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};

const prepModule = await runtimeModule(runtimeDir);
const rackCell = defineCell(prepModule, "cold-rack-cell");
const espressoCell = defineCell(prepModule, "espresso-cell", {
  fixture: "espresso",
  appliance: "linea",
});
const eagleCell = defineCell(prepModule, "espresso-cell", {
  fixture: "espresso",
  appliance: "eagle-one",
});
const wasmApplianceModule = () => runtimeModule(runtimeDir);

function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}

async function runScenarioToCompletion(name, scenario, cells) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtimeDir), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells,
    identity: {
      runId: `${name}-run`,
      executionId: `${name}-exec`,
      hostSession: `host-${name}`,
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));

  const horizonUs = scenario.limits.horizon;
  for (let turn = 0; turn < 6000; turn++) {
    const reply = await host.handle({
      kind: "drive",
      turns: 128,
      until: horizonUs,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (reply.view.status.kind === "awaiting-inspection") {
      const pending = reply.view.inspections.find(
        (entry) => entry.kind === "pending",
      );
      assert.ok(pending, "Expected pending inspection");
      const decision = evaluatePendingInspectionGate(pending.task);
      const commanded = await host.handle({
        kind: "inspect",
        commandId: `inspect-${turn}-${pending.task.replace(/[^a-z0-9-]/gi, "-")}`,
        expectedControlRevision: reply.view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome: decision.recommendedOutcome,
        note: `${decision.gateKind}: ${decision.rationale}`,
      });
      assert.equal(commanded.kind, "commanded");
      assert.equal(commanded.receipt.status, "accepted");
      continue;
    }
    if (reply.view.status.kind === "completed") {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      await host.handle({ kind: "dispose" });
      return state.run;
    }
    if (
      reply.view.status.kind === "blocked" ||
      reply.view.status.kind === "stopped-at-limit"
    ) {
      throw new Error(
        `Scenario ${name} stopped in ${JSON.stringify(reply.view.status)}`,
      );
    }
  }
  throw new Error(`Scenario ${name} exceeded turn bound`);
}

function assertValidReport(label, report, expectedCategories) {
  assert.ok(report.taskCount > 0, `${label}: expected appliance tasks`);
  const seenCategories = new Set();
  const lastDigestByAppliance = new Map();
  for (const record of report.records) {
    assert.equal(
      record.result.outcome.kind,
      "completed",
      `${label}: ${record.taskId} did not complete`,
    );
    assert.ok(record.sampleCount >= 2, `${label}: ${record.taskId} samples`);
    assert.ok(
      record.simulatedSeconds > 0,
      `${label}: ${record.taskId} sim time`,
    );
    assert.match(record.recordingDigest, /^[a-f0-9]{64}$/u);
    assert.match(record.checkpointDigest, /^[a-f0-9]{64}$/u);
    assert.equal(
      record.resumedFromCheckpointDigest,
      lastDigestByAppliance.get(record.appliance) ?? null,
      `${label}: broken checkpoint chain at ${record.taskId}`,
    );
    lastDigestByAppliance.set(record.appliance, record.checkpointDigest);
    seenCategories.add(record.category);
  }
  for (const cat of expectedCategories) {
    assert.ok(seenCategories.has(cat), `${label}: missing category ${cat}`);
  }
}

// 1. Standalone Pie recipe via unified data table
const pieScenario = unwrap(await compilePieRecipe(pieRecipeInput()));
const pieRun = await runScenarioToCompletion("standalone-pie", pieScenario, []);
const pieReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(pieRun),
  wasmApplianceModule,
  { runId: "standalone-pie", scheduledTasks: extractScheduledTasks(pieRun) },
);
assertValidReport("standalone-pie", pieReport, [
  "weigh",
  "mixer",
  "hob",
  "chiller",
  "pastry-bench",
  "oven",
  "dishwasher",
]);
console.log(
  `Standalone Pie: ${pieReport.taskCount} tasks across ${pieReport.applianceCount} appliances verified.`,
);

// 2. Standalone Espresso (Linea + Eagle One variants) via unified data table
const lineaScenario = await compileEspresso(
  { revision: 1, orders: 1, appliance: "linea" },
  unwrap(parseNativeCell(espressoCell)),
);
const lineaRun = await runScenarioToCompletion(
  "standalone-espresso-linea",
  lineaScenario,
  [espressoCell],
);
const lineaReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(lineaRun, { espressoAppliance: "linea" }),
  wasmApplianceModule,
  { runId: "standalone-espresso-linea" },
);
assertValidReport("standalone-espresso-linea", lineaReport, ["espresso"]);
assert.equal(lineaReport.taskCount, 1);
assert.ok(
  lineaReport.records.some(
    (r) => r.appliance === "la-marzocco-linea-classic-s-2g",
  ),
);

const eagleScenario = await compileEspresso(
  { revision: 1, orders: 1, appliance: "eagle-one" },
  unwrap(parseNativeCell(eagleCell)),
);
const eagleRun = await runScenarioToCompletion(
  "standalone-espresso-eagle-one",
  eagleScenario,
  [eagleCell],
);
const eagleReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(eagleRun, { espressoAppliance: "eagle-one" }),
  wasmApplianceModule,
  { runId: "standalone-espresso-eagle-one" },
);
assertValidReport("standalone-espresso-eagle-one", eagleReport, ["espresso"]);
assert.equal(eagleReport.taskCount, 1);
assert.ok(
  eagleReport.records.some(
    (r) => r.appliance === "victoria-arduino-eagle-one-2g",
  ),
);
console.log(
  `Standalone Espresso: Linea (${lineaReport.taskCount} task) and Eagle One (${eagleReport.taskCount} task) verified.`,
);

// 3. Standalone Pour-Over workflow via unified data table
const pourOverBase = await compilePourOverShiftWorkflow({
  revision: 1,
  orders: 1,
  grinder: "option-o-lagom-casa",
  arrivalsSeconds: [0],
});
const pourOverScenario = {
  ...pourOverBase,
  resources: [
    ...pourOverBase.resources,
    {
      kind: "worker",
      id: "tea-worker",
      capacity: 1,
      configuration: null,
      initialLocation: "coffee-station",
      travel: [],
    },
  ],
};
const pourOverRun = await runScenarioToCompletion(
  "standalone-pour-over",
  pourOverScenario,
  [],
);
const pourOverReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(pourOverRun),
  wasmApplianceModule,
  { runId: "standalone-pour-over" },
);
assertValidReport("standalone-pour-over", pourOverReport, [
  "weigh",
  "grinder",
  "hob",
  "dishwasher",
]);
assert.equal(pourOverReport.taskCount, 4);
console.log(
  `Standalone Pour-Over: ${pourOverReport.taskCount} tasks across ${pourOverReport.applianceCount} appliances verified.`,
);

// 4. Plan 84 Canvas-Edited Financier Recipe:
//    - Edit `brown-butter` duration (+30 s) via `withStepSeconds`
//    - Add a wait step `"Rest batter tray"` (20 s) via `newStepNode`
//    - Add a duplicate appliance step `"Bake"` (`bake-2`) in `financier-batch`
//    - Lower via `compileDraft`, run in Wasm host, verify appliance physics report
const baseFinancier = unwrap(
  await compileFinancierRecipe(financierRecipeInput(2, 2, 900), rackCell),
);
const financierDoc = importScenario(baseFinancier, {
  title: "Canvas Financier",
  recipe: "financier",
});
const seed = draftSeed(financierDoc);

const editedNodes = seed.nodes.map((node) => {
  if (node.key !== "brown-butter") return node;
  const body = withStepSeconds(node.body, 360);
  assert.ok(body !== null, "Expected brown-butter duration edit to succeed");
  return { ...node, body };
});
const bakeNode = editedNodes.find((n) => n.key === "bake");
assert.ok(bakeNode !== undefined, "Expected bake step in financier draft");

const waitStep = newStepNode(
  financierDoc,
  { ...seed, nodes: editedNodes },
  {
    workflow: bakeNode.workflow,
    kind: "wait",
    label: "Rest batter tray",
    seconds: 20,
  },
);
assert.ok(waitStep !== null, "Expected canvas wait step creation");
const nodesWithWait = [...editedNodes, waitStep];

const secondBakeStep = newStepNode(
  financierDoc,
  { ...seed, nodes: nodesWithWait },
  {
    workflow: bakeNode.workflow,
    kind: "work",
    label: "Bake",
    seconds: 15,
  },
);
assert.ok(secondBakeStep !== null, "Expected canvas duplicate bake step");
assert.equal(secondBakeStep.key, "bake-2");

const editedSnapshot = {
  nodes: [...nodesWithWait, secondBakeStep],
  edges: [
    ...seed.edges,
    {
      workflow: bakeNode.workflow,
      from: bakeNode.key,
      to: waitStep.key,
      order: seed.edges.length,
      branch: null,
    },
    {
      workflow: bakeNode.workflow,
      from: waitStep.key,
      to: secondBakeStep.key,
      order: seed.edges.length + 1,
      branch: null,
    },
  ],
  positions: {
    ...seed.positions,
    [`${waitStep.workflow}/${waitStep.key}`]: { x: 420, y: 120 },
    [`${secondBakeStep.workflow}/${secondBakeStep.key}`]: { x: 660, y: 120 },
  },
};

const compiledCanvas = await compileDraft(financierDoc, editedSnapshot);
assert.equal(
  compiledCanvas.kind,
  "ready",
  `Canvas draft refused: ${JSON.stringify(compiledCanvas)}`,
);
const canvasTaskKinds = workflowApplianceTaskKinds(compiledCanvas.document);
assert.equal(canvasTaskKinds[`${bakeNode.workflow}/bake`], "oven-bake");
assert.equal(canvasTaskKinds[`${bakeNode.workflow}/bake-2`], "oven-bake");
assert.equal(
  canvasTaskKinds[`${bakeNode.workflow}/${waitStep.key}`],
  undefined,
);

const canvasFinancierRun = await runScenarioToCompletion(
  "canvas-edited-financier",
  compiledCanvas.scenario,
  [rackCell],
);
const canvasFinancierBindings = recipeApplianceTasks(canvasFinancierRun);
const canvasFinancierReport = await executeRecipeApplianceTasks(
  canvasFinancierBindings,
  wasmApplianceModule,
  {
    runId: "canvas-edited-financier",
    scheduledTasks: extractScheduledTasks(canvasFinancierRun),
  },
);
assertValidReport("canvas-edited-financier", canvasFinancierReport, [
  "weigh",
  "hob",
  "mixer",
  "oven",
  "chiller",
  "dishwasher",
]);
// Original 28 financier appliance checks + 1 instance of canvas-added `bake-2` on bakeNode.workflow
assert.equal(
  canvasFinancierReport.taskCount,
  29,
  `Expected 29 appliance checks (28 base + 1 canvas bake-2), got ${canvasFinancierReport.taskCount}`,
);
const addedBakeRecords = canvasFinancierReport.records.filter(
  (r) => r.taskKey === "bake-2" && r.appliance === "maruzen-mbco-5e",
);
assert.equal(addedBakeRecords.length, 1);

// Verify D3: hotspot bake is flagged at risk in the report while the schedule task stayed completed.
const canvasRisks = atRiskTasksFromApplianceReport(canvasFinancierReport);
assert.ok(
  canvasRisks.has("load-hazelnut-b#0/bake"),
  "Expected load-hazelnut-b#0/bake hotspot tray to be marked at risk",
);
const scheduledHotspotTask = canvasFinancierRun.tasks.find(
  (t) => t.id === "load-hazelnut-b#0/bake",
);
assert.equal(
  scheduledHotspotTask?.kind,
  "completed",
  "D3: failed appliance check must not fail the schedule task",
);
console.log(
  `Canvas-Edited Financier: ${canvasFinancierReport.taskCount} tasks across ${canvasFinancierReport.applianceCount} appliances verified (${canvasRisks.size} at risk).`,
);

// 5. Custom Canvas Workflow (non-built-in workflow id using canonical task kinds)
const customWorkflowId = "canvas-tasting-batch";
const customBaseDoc = {
  ...financierDoc,
  title: "Custom Canvas Tasting",
  recipe: "canvas-custom",
  scenario: { ...financierDoc.scenario, id: "canvas-tasting-scenario" },
  world: {
    products: [],
    destinations: [],
    resources: [financierDoc.world.resources.find((r) => r.kind === "worker")],
    storages: [],
    carriers: [],
    cells: [],
    stock: [],
  },
  demand: {
    limits: financierDoc.demand.limits,
    arrivals: [
      {
        id: "tasting-batch",
        workflow: customWorkflowId,
        kind: "explicit",
        arrivals: [{ time: 0, quantity: 1 }],
      },
    ],
    dependencies: [],
    availability: [],
  },
  workflows: [
    {
      id: customWorkflowId,
      revision: "0".repeat(64),
      demand: "production",
      nodes: [],
      edges: [],
    },
  ],
};
const worker = customBaseDoc.world.resources[0];
assert.ok(worker !== undefined && worker.kind === "worker");
const customStepSpecs = [
  { label: "Weigh flour", seconds: 15 },
  { label: "Mix batter", seconds: 25 },
  { label: "Bake sample", seconds: 30 },
  { label: "Chill sample", seconds: 20 },
  { label: "Wash tray", seconds: 15 },
];
let customSnap = { nodes: [], edges: [], positions: {} };
for (let i = 0; i < customStepSpecs.length; i++) {
  const spec = customStepSpecs[i];
  const node = newStepNode(customBaseDoc, customSnap, {
    workflow: customWorkflowId,
    kind: "work",
    label: spec.label,
    seconds: spec.seconds,
  });
  assert.ok(node !== null);
  const prev = customSnap.nodes.at(-1);
  customSnap = {
    nodes: [...customSnap.nodes, node],
    edges:
      prev === undefined
        ? customSnap.edges
        : [
            ...customSnap.edges,
            {
              workflow: customWorkflowId,
              from: prev.key,
              to: node.key,
              order: i - 1,
              branch: null,
            },
          ],
    positions: {
      ...customSnap.positions,
      [`${customWorkflowId}/${node.key}`]: { x: i * 240, y: 0 },
    },
  };
}
const compiledCustom = await compileDraft(customBaseDoc, customSnap);
assert.equal(
  compiledCustom.kind,
  "ready",
  `Custom canvas workflow refused: ${JSON.stringify(compiledCustom)}`,
);
const customKinds = workflowApplianceTaskKinds(compiledCustom.document);
assert.deepEqual(customKinds, {
  "canvas-tasting-batch/weigh-flour": "weigh",
  "canvas-tasting-batch/mix-batter": "planetary-mix",
  "canvas-tasting-batch/bake-sample": "oven-bake",
  "canvas-tasting-batch/chill-sample": "chiller",
  "canvas-tasting-batch/wash-tray": "dishwasher",
});
const customRun = await runScenarioToCompletion(
  "canvas-custom-tasting",
  compiledCustom.scenario,
  [],
);
const customReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(customRun),
  wasmApplianceModule,
  { runId: "canvas-custom-tasting" },
);
assertValidReport("canvas-custom-tasting", customReport, [
  "weigh",
  "mixer",
  "oven",
  "chiller",
  "dishwasher",
]);
assert.equal(customReport.taskCount, 5);
console.log(
  `Custom Canvas Workflow: ${customReport.taskCount} tasks across ${customReport.applianceCount} appliances verified.`,
);

const summary = {
  passed: true,
  executionBundleId: manifest.bundle.id,
  runtimeBundleId: manifest.runtime.id,
  standaloneRecipes: {
    pie: {
      taskCount: pieReport.taskCount,
      applianceCount: pieReport.applianceCount,
      checkpointDigests: pieReport.checkpointDigests,
    },
    espressoLinea: {
      taskCount: lineaReport.taskCount,
      applianceCount: lineaReport.applianceCount,
      checkpointDigests: lineaReport.checkpointDigests,
    },
    espressoEagleOne: {
      taskCount: eagleReport.taskCount,
      applianceCount: eagleReport.applianceCount,
      checkpointDigests: eagleReport.checkpointDigests,
    },
    pourOver: {
      taskCount: pourOverReport.taskCount,
      applianceCount: pourOverReport.applianceCount,
      checkpointDigests: pourOverReport.checkpointDigests,
    },
  },
  canvasEditedFinancier: {
    taskCount: canvasFinancierReport.taskCount,
    applianceCount: canvasFinancierReport.applianceCount,
    addedBakeTaskIds: addedBakeRecords.map((r) => r.taskId),
    atRiskTaskIds: [...canvasRisks.keys()],
    hotspotScheduleKind: scheduledHotspotTask?.kind,
    checkpointDigests: canvasFinancierReport.checkpointDigests,
  },
  customCanvasWorkflow: {
    taskCount: customReport.taskCount,
    applianceCount: customReport.applianceCount,
    taskKinds: customKinds,
    checkpointDigests: customReport.checkpointDigests,
  },
};

writeFileSync(join(output, "report.json"), `${canonicalJson(summary)}\n`);
console.log(JSON.stringify(summary, null, 2));
