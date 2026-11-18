// Compile the current financier recipe and compare persistent execution with
// its established scheduler, through fresh retained hosts and finite buffers.
import {
  beginRun,
  evidenceWriter,
  pendingInspection,
  sameId,
  textCodec,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  parseSettings,
  sampleSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import {
  compileFinancier,
  compileFinancierPreparation,
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import {
  resolveAuthoredFinancierRun,
  simulateSteps,
} from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { buildExecutionBundle } from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
const save = evidenceWriter(output);
assert.equal(existsSync(output), false, "Choose a fresh output directory");
mkdirSync(output, { recursive: true });
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${BAKERY_BROWSER_BUNDLE.id}`,
);
const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const bundle = built.manifest.bundle;
const engine = { E, runtime, codec: textCodec() };

function settings(overrides) {
  const parsed = parseSettings({ ...sampleSettings(), ...overrides });
  assert.equal(parsed.kind, "valid", JSON.stringify(parsed));
  return parsed.settings;
}
function open(scenario, saved, leg) {
  return beginRun(engine, {
    bundle,
    cells: [],
    runId: "financier",
    executionId: `execution-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}
async function drive(host, seconds) {
  const reply = await host.handle({
    kind: "drive",
    turns: 128,
    until: seconds * 1_000_000,
  });
  assert.equal(reply.kind, "drove", JSON.stringify(reply));
  const state = await host.handle({ kind: "state" });
  assert.equal(state.kind, "state");
  return state.run;
}
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
function taskId(task) {
  const key =
    task.kind === "process"
      ? task.operation
      : `transfer-${task.from}-${task.station}`;
  return `batch-${task.batch}#0/${key}`;
}
function taskEvent(kind, id, event) {
  return event.kind === kind && event.task === id;
}
function compare(reference, run) {
  assert.equal(
    run.status.kind,
    reference.kind === "complete" ? "completed" : "stopped-at-limit",
  );
  assert.equal(run.position.time / 1_000_000, reference.end, "Run completion");
  for (const task of reference.intervals) {
    if (task.kind === "wait") continue;
    const id = taskId(task);
    const actual = run.tasks.find(sameId.bind(null, id));
    assert.ok(actual, id);
    assert.equal(actual.startedAt / 1_000_000, task.start, `${id} starts`);
    if (task.end <= reference.end) {
      assert.equal(actual.kind, "completed");
      assert.equal(actual.completedAt / 1_000_000, task.end, `${id} ends`);
    } else {
      assert.equal(actual.kind, "executing");
      assert.equal(
        actual.completesAt / 1_000_000,
        task.end,
        `${id} pending completion`,
      );
    }
    if (task.attended) {
      const assignment = run.events.find(
        taskEvent.bind(null, "worker-assigned", id),
      );
      assert.equal(assignment.worker, task.executor, `${id} worker`);
    }
    if (task.kind === "transfer") {
      const pickup = run.events.find(
        taskEvent.bind(null, "carrier-picked-up", id),
      );
      const placed = run.events.find(
        taskEvent.bind(null, "carrier-placed", id),
      );
      if (task.pickup <= reference.end)
        assert.equal(pickup.time / 1_000_000, task.pickup, `${id} pickup`);
      else assert.equal(pickup, undefined);
      if (task.end <= reference.end)
        assert.equal(placed.time / 1_000_000, task.end, `${id} placement`);
      else assert.equal(placed, undefined);
    }
  }
  const cycles = [];
  for (const event of run.events)
    if (event.kind === "batch-started")
      cycles.push([event.time / 1_000_000, event.completesAt / 1_000_000]);
  const expectedCycles = [];
  for (const cycle of reference.cycles)
    expectedCycles.push([cycle.start, cycle.end]);
  assert.deepEqual(cycles, expectedCycles, "Shared oven cycles");
}
async function runCase(name, overrides, variant, rules) {
  const input = settings(overrides);
  const resolved = value(resolveAuthoredFinancierRun(input, variant, rules));
  const scenario = await compileFinancier(resolved);
  value(await E.admitScenario(scenario));
  const steps = simulateSteps(resolved);
  let step = steps.next();
  while (!step.done) step = steps.next();
  const reference = step.value;
  assert.ok(reference.kind === "complete" || reference.kind === "horizon");
  save(`${name}-input.json`, { settings: input, variant, rules, scenario });
  save(`${name}-finite-reference.json`, reference);
  const baselineHost = await open(scenario, null, 0);
  const baseline = await drive(baselineHost, input.horizonMinutes * 60);
  save(`${name}-persistent.json`, baseline);
  compare(reference, baseline);
  await baselineHost.handle({ kind: "dispose" });

  let host = await open(scenario, null, 1);
  let leg = 1;
  const boundaries = [
    reference.cycles[0].start + 1,
    reference.cycles[0].end + 1,
  ];
  if (rules.length > 0) boundaries.unshift(1);
  for (const boundary of boundaries) {
    const state = await drive(host, boundary);
    assert.equal(state.status.kind, "advancing");
    if (rules.length > 0 && boundary === 1) {
      const waiting = state.tasks.find(sameId.bind(null, "batch-A#0/stage"));
      assert.equal(waiting.kind, "waiting");
      assert.ok(waiting.blockers.some(isFuturePrerequisite));
      assert.equal(
        state.tasks.find(sameId.bind(null, "batch-C#0/portion")),
        undefined,
      );
    }
    const paused = await host.handle({
      kind: "pause",
      commandId: `pause-${leg}`,
    });
    assert.equal(paused.receipt.status, "accepted");
    const saved = await host.handle({ kind: "save" });
    assert.equal(saved.kind, "saved", JSON.stringify(saved));
    save(`${name}-save-${leg}.json`, saved);
    if (leg === 1) {
      const edited = structuredClone(saved.document);
      edited.state.identity.bundle = null;
      const { snapshot: _snapshot, ...content } = edited;
      edited.snapshot = await sha256Hex(canonicalJson(content));
      const refused = await E.openResumable(edited, "browser", [bundle]);
      assert.deepEqual(refused, {
        ok: false,
        error: { code: "invalid_document" },
      });
      save(`${name}-unpinned-save-refused.json`, {
        document: edited,
        result: refused,
      });
    }
    await host.handle({ kind: "dispose" });
    host = await open(scenario, saved, ++leg);
  }
  const continued = await drive(host, input.horizonMinutes * 60);
  save(`${name}-continued.json`, continued);
  compare(reference, continued);
  assert.deepEqual(history(continued), history(baseline));
  assert.deepEqual(world(continued), world(baseline));
  const results = E.runResults(continued, {
    after: null,
    through: continued.position.time,
  });
  save(`${name}-results.json`, results);
  let quantity = 0;
  for (const entry of results.reported)
    if (entry.destination === "packed-financiers") quantity += entry.amount;
  assert.equal(
    quantity,
    reference.completions.length * input.traysPerBatch * input.piecesPerTray,
  );
  assert.equal(results.ordersCompleted, reference.completions.length);
  if (reference.kind === "complete") {
    for (const carrier of continued.carriers) {
      assert.equal(carrier.bound, null);
      assert.equal(carrier.custody.kind, "stored");
      assert.equal(carrier.custody.storage, "dispatch");
    }
  } else {
    const savedLimit = await host.handle({ kind: "save" });
    assert.equal(savedLimit.kind, "saved");
    save(`${name}-limit-save.json`, savedLimit);
    value(await E.openResumable(savedLimit.document, "browser", [bundle]));
  }
  await host.handle({ kind: "dispose" });
  if (rules.length > 0)
    await refusedAuthoring(input, rules, scenario, continued, name);
  return {
    name,
    status: continued.status.kind,
    simulatedSeconds: reference.end,
    cycles: reference.cycles.length,
    batches: input.batchCount,
    packed: quantity,
    restores: boundaries,
  };
}

function isFuturePrerequisite(blocker) {
  return (
    blocker.kind === "prerequisite" && blocker.task === "batch-C#0/portion"
  );
}

async function refusedAuthoring(input, rules, scenario, run, name) {
  const refusals = [];
  for (const [label, patch] of [
    ["worker", { workerId: "human-3" }],
    ["time", { earliestStartSeconds: input.horizonMinutes * 60 }],
    ["reference", { dependsOn: ["batch:X:process:stage"] }],
    ["cycle", { dependsOn: ["batch:A:process:pack"] }],
  ]) {
    const edited = structuredClone(rules);
    Object.assign(edited[0], patch);
    const result = resolveAuthoredFinancierRun(input, "normal", edited);
    assert.equal(result.ok, false, label);
    refusals.push({ label, input: edited, result });
  }
  for (const label of ["occurrence", "task", "duplicate", "cycle"]) {
    const edited = structuredClone(scenario);
    const edge = edited.dependencies[0];
    if (label === "occurrence") edge.prerequisite.sequence = 1;
    if (label === "task") edge.prerequisite.key = "missing";
    if (label === "duplicate") edited.dependencies.push(structuredClone(edge));
    if (label === "cycle")
      edited.dependencies.push({
        task: { source: "batch-C", sequence: 0, key: "stage" },
        prerequisite: { source: "batch-A", sequence: 0, key: "portion" },
      });
    const result = await E.admitScenario(edited);
    assert.equal(result.ok, false, label);
    refusals.push({ label: `compiled-${label}`, input: edited, result });
  }
  const host = await open(scenario, null, "refusal");
  await drive(host, input.horizonMinutes * 60);
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved");
  const edited = structuredClone(saved.document);
  const dependent = edited.state.tasks.find(
    sameId.bind(null, "batch-A#0/stage"),
  );
  const upstream = run.tasks.find(sameId.bind(null, "batch-C#0/portion"));
  dependent.startedAt = upstream.completedAt - 2_000;
  const { snapshot: _snapshot, ...content } = edited;
  edited.snapshot = await sha256Hex(canonicalJson(content));
  const result = await E.openResumable(edited, "browser", [bundle]);
  assert.equal(
    result.ok,
    false,
    "A dependent cannot start before its prerequisite completes",
  );
  refusals.push({ label: "saved-dependency-order", input: edited, result });
  await host.handle({ kind: "dispose" });
  save(`${name}-refusals.json`, refusals);
}

const authoredRules = [
  {
    bakeryTaskId: "batch:A:process:stage",
    workerId: "human-2",
    earliestStartSeconds: 600,
    dependsOn: ["batch:C:process:portion"],
  },
  {
    bakeryTaskId: "batch:B:process:stage",
    workerId: "human-1",
    earliestStartSeconds: 3000,
    dependsOn: ["batch:A:transfer:stage:portion"],
  },
  {
    bakeryTaskId: "batch:C:process:pack",
    workerId: "human-1",
    earliestStartSeconds: 0,
    dependsOn: ["batch:B:process:stage"],
  },
];

const cases = [
  ["normal", {}, "normal"],
  ["outage", { horizonMinutes: 240 }, "outage"],
  ["shift-limit", { horizonMinutes: 30, outageEnd: 20 }, "normal"],
  [
    "blocked-cooling",
    { batchCount: 6, rackTrays: 2, horizonMinutes: 240, loadWindow: 10 },
    "normal",
  ],
  [
    "whole-batch-slots",
    { batchCount: 4, ovenTrays: 3, rackTrays: 3, horizonMinutes: 240 },
    "outage",
  ],
  [
    "zero-window",
    { batchCount: 4, loadWindow: 0, workerCount: 1, horizonMinutes: 240 },
    "normal",
  ],
];
const reports = [];
for (const [name, overrides, variant] of cases)
  reports.push(await runCase(name, overrides, variant, []));
for (const variant of ["normal", "outage"])
  reports.push(
    await runCase(
      `authored-${variant}`,
      { workerCount: 2, rackTrays: 6, horizonMinutes: 240 },
      variant,
      authoredRules,
    ),
  );
const occurrences = [];
for (const kind of ["explicit", "count", "until"])
  occurrences.push(await occurrenceJourney(kind));
const preparation = [];
for (const capacity of [1_490_000, 745_000])
  preparation.push(await preparationJourney(capacity));
const recipes = [];
for (const slots of [1, 2]) recipes.push(await recipeJourney(slots));
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  reports,
  occurrences,
  preparation,
  recipes,
});
console.log(`Financier compiler journey passed: ${output}`);

function preparationInput(holdingCapacityMg) {
  return {
    revision: 1,
    evidence: "assumed",
    flavour: "hazelnut",
    // The hazelnut financier: 40 g of the almond flour is roasted hazelnut
    // flour, plus 20 g chopped roasted hazelnut.
    ingredientsMg: {
      butter: 180_000,
      "egg-whites": 180_000,
      "almond-flour": 60_000,
      "wheat-flour": 100_000,
      sugar: 195_000,
      "roasted-hazelnut-flour": 40_000,
      "chopped-roasted-hazelnut": 20_000,
    },
    brownedButterMg: 158_000,
    batterMg: 745_000,
    evaporationMg: 22_000,
    residueMg: 8_000,
    spillMg: 0,
    measurementDifferenceMg: 0,
    holdingCapacityMg,
    durationsSeconds: {
      weigh: 10,
      "brown-butter": 360,
      "return-pan": 10,
      mix: 120,
      "store-batter": 30,
      clean: 90,
      "put-away": 10,
    },
    travelSeconds: 5,
    arrivalsSeconds: [0, 1],
    horizonSeconds: 3600,
  };
}

function preparationTask(run, batch, key) {
  const id = `hazelnut-preparation-batches#${batch}/${key}`;
  const found = run.tasks.find(sameId.bind(null, id));
  assert.ok(found, id);
  return found;
}

function preparationOutput(run) {
  const result = E.runResults(run, {
    after: null,
    through: run.position.time,
  });
  let remaining = 0;
  let losses = 0;
  let prepared = 0;
  for (const stock of result.stock) {
    assert.equal(stock.unit, "milligram");
    remaining += stock.remaining;
  }
  for (const output of result.reported) {
    assert.equal(output.unit, "milligram");
    assert.notEqual(output.role, "final-output");
    if (output.role === "loss") losses += output.amount;
    if (output.destination === "hazelnut-batter-prepared") prepared += output.amount;
  }
  assert.equal(
    remaining + losses,
    1_550_000,
    "Both ingredient batches balance",
  );
  return {
    remainingMg: remaining,
    lossMg: losses,
    preparedMg: prepared,
    result,
  };
}

async function preparationJourney(capacity) {
  const name = `preparation-${capacity}`;
  const input = preparationInput(capacity);
  const scenario = value(await compileFinancierPreparation(input));
  value(await E.admitScenario(scenario));
  save(`${name}-input.json`, { input, scenario });
  const baselineHost = await open(scenario, null, `${name}-baseline`);
  const baseline = await drive(baselineHost, input.horizonSeconds);
  save(`${name}-baseline.json`, baseline);
  await baselineHost.handle({ kind: "dispose" });

  // Reopen during butter browning, mixing, cleaning, and a vessel transfer.
  const boundaries = [];
  for (const key of ["brown-butter", "mix", "clean", "put-away"]) {
    const task = preparationTask(baseline, 0, key);
    assert.equal(task.kind, "completed");
    boundaries.push(task.startedAt / 1_000_000 + 1);
  }
  let host = await open(scenario, null, `${name}-0`);
  for (const [leg, boundary] of boundaries.entries()) {
    const state = await drive(host, boundary);
    assert.equal(state.status.kind, "advancing");
    preparationOutput(state);
    assert.equal(preparationTask(state, 1, "weigh-butter").kind, "waiting");
    for (const carrier of state.carriers) assert.notEqual(carrier.bound, null);
    save(`${name}-state-${leg}.json`, state);
    const paused = await host.handle({
      kind: "pause",
      commandId: `pause-${leg}`,
    });
    assert.equal(paused.receipt.status, "accepted");
    const saved = await host.handle({ kind: "save" });
    assert.equal(saved.kind, "saved", JSON.stringify(saved));
    save(`${name}-save-${leg}.json`, saved);
    await host.handle({ kind: "dispose" });
    host = await open(scenario, saved, `${name}-${leg + 1}`);
  }
  const continued = await drive(host, input.horizonSeconds);
  assert.deepEqual(history(continued), history(baseline));
  assert.deepEqual(world(continued), world(baseline));
  const output = preparationOutput(continued);
  assert.equal(
    output.lossMg,
    60_000,
    "Only declared evaporation and residue exit",
  );
  assert.equal(output.remainingMg, 1_490_000);
  save(`${name}-continued.json`, continued);
  save(`${name}-results.json`, output);
  const released = preparationTask(continued, 0, "put-away");
  const reused = preparationTask(continued, 1, "weigh-butter");
  assert.equal(reused.kind, "completed");
  assert.ok(
    reused.startedAt >= released.completedAt,
    "Reuse follows cleaning and return",
  );
  for (const batch of [0, 1]) {
    const weighed = preparationTask(continued, batch, "weigh-chopped-roasted-hazelnut");
    const brown = preparationTask(continued, batch, "brown-butter");
    const mix = preparationTask(continued, batch, "mix");
    assert.ok(brown.startedAt >= weighed.completedAt);
    assert.ok(mix.startedAt >= brown.completedAt);
    const mixedInputs = [`hazelnut-preparation-batches#${batch}/browned-butter`];
    for (const ingredient of Object.keys(input.ingredientsMg)) {
      const id = `hazelnut-preparation-batches#${batch}/weighed-${ingredient}`;
      const weighedLot = continued.lots.find(sameId.bind(null, id));
      assert.deepEqual(weighedLot.lineage, [`${ingredient}-stock`]);
      if (ingredient !== "butter") mixedInputs.push(id);
    }
    const mixed = continued.lots.find(
      sameId.bind(null, `hazelnut-preparation-batches#${batch}/mixed-batter`),
    );
    assert.deepEqual(new Set(mixed.lineage), new Set(mixedInputs));
  }
  for (const resource of output.result.resources) {
    let previousEnd = 0;
    for (const interval of resource.intervals) {
      if (interval.kind !== "occupied") continue;
      assert.ok(
        interval.start >= previousEnd,
        `${resource.resource} work cannot overlap`,
      );
      previousEnd = interval.end;
    }
  }
  if (capacity === 745_000) {
    assert.equal(continued.status.kind, "blocked");
    assert.equal(output.preparedMg, 745_000);
    const blocked = preparationTask(continued, 1, "store-batter");
    assert.equal(blocked.kind, "waiting");
    assert.deepEqual(blocked.blockers, [
      { kind: "destination", storage: "hazelnut-batter-holding" },
    ]);
    assert.equal(preparationTask(continued, 1, "clean").kind, "waiting");
    for (const carrier of continued.carriers)
      assert.notEqual(carrier.bound, null);
  } else {
    assert.equal(continued.status.kind, "completed");
    assert.equal(output.preparedMg, 1_490_000);
    for (const carrier of continued.carriers) {
      assert.equal(carrier.bound, null);
      assert.equal(carrier.custody.kind, "stored");
      assert.equal(
        carrier.custody.storage,
        `clean-${carrier.id.split("-")[0]}`,
      );
    }
  }
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved");
  save(`${name}-final-save.json`, saved);
  await host.handle({ kind: "dispose" });
  const reopened = await open(scenario, saved, `${name}-final`);
  const final = await drive(reopened, input.horizonSeconds);
  assert.deepEqual(
    world(final),
    world(continued),
    "Final custody and storage survive reopen",
  );
  await reopened.handle({ kind: "dispose" });

  const refusals = [];
  for (const [field, amount, code] of [
    ["brownedButterMg", 180_000, "browning_mass_balance"],
    ["batterMg", 753_000, "mixing_mass_balance"],
    ["spillMg", -1, "invalid_preparation"],
    ["batterMg", 745_000.5, "invalid_preparation"],
    ["measurementDifferenceMg", 1, "invalid_preparation"],
  ]) {
    const edited = structuredClone(input);
    edited[field] = amount;
    const refusal = await compileFinancierPreparation(edited);
    assert.deepEqual(refusal, { ok: false, error: { code } });
    refusals.push({ input: edited, refusal });
  }
  save(`${name}-refusals.json`, refusals);
  return {
    name,
    status: continued.status.kind,
    inputMg: 1_550_000,
    remainingMg: output.remainingMg,
    lossMg: output.lossMg,
    preparedMg: output.preparedMg,
    restores: boundaries,
    source: scenario.sources[0],
  };
}

async function occurrenceJourney(kind) {
  const source = {
    id: "orders",
    workflow: "work",
    kind: "periodic",
    first: 0,
    interval: 1_000_000,
    limit:
      kind === "count"
        ? { kind: "count", count: 3 }
        : { kind: "until", end: 2_000_000 },
  };
  const arrivals =
    kind === "explicit"
      ? [
          {
            id: "orders",
            workflow: "work",
            kind: "explicit",
            arrivals: [
              { time: 0, quantity: 2 },
              { time: 2_000_000, quantity: 1 },
            ],
          },
        ]
      : [source];
  const tasks = [];
  for (const key of ["start", "end"])
    tasks.push({
      key,
      priority: 0,
      releaseAfter: 0,
      prerequisites: key === "end" ? ["start"] : [],
      claims: [],
      executor: { kind: "declared", duration: 2_000_000, evidence: "assumed" },
      inputs: [],
      outputs: [],
      releases: [],
      carriers: [],
    });
  const scenario = {
    schemaVersion: E.SCENARIO_SCHEMA_VERSION,
    id: "occurrences",
    policy: E.DISPATCH_POLICY,
    sources: [],
    limits: { horizon: 60_000_000, eventCap: 1000 },
    products: [],
    destinations: [],
    resources: [],
    storages: [],
    carriers: [],
    cells: [],
    stock: [],
    workflows: [
      { id: "work", revision: "0".repeat(64), demand: "order", tasks },
    ],
    arrivals,
    availability: [],
    dependencies: [
      {
        task: { source: "orders", sequence: 0, key: "start" },
        prerequisite: { source: "orders", sequence: 2, key: "end" },
      },
    ],
  };
  const host = await open(scenario, null, kind);
  const run = await drive(host, 60);
  assert.equal(run.status.kind, "completed");
  assert.equal(run.instances.length, 3);
  assert.equal(
    run.tasks.find(sameId.bind(null, "orders#0/start")).startedAt,
    6_000_000,
  );
  assert.equal(run.position.time, 10_000_000);
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved");
  value(await E.openResumable(saved.document, "browser", [bundle]));
  await host.handle({ kind: "dispose" });
  const invalid = structuredClone(scenario);
  invalid.dependencies[0].prerequisite.sequence = 3;
  const refusal = await E.admitScenario(invalid);
  assert.equal(refusal.ok, false);
  save(`occurrences-${kind}.json`, { scenario, run, saved, invalid, refusal });
  return { kind, instances: 3, simulatedSeconds: 10 };
}

function recipeInput(gridSlots) {
  return financierRecipeInput(3, gridSlots, 900);
}

async function driveRecipe(host, until, label) {
  for (let turn = 0; turn < 20; turn++) {
    const run = await drive(host, until);
    recipeBalance(run);
    if (run.status.kind !== "awaiting-inspection") return run;
    const reply = await host.handle({ kind: "state" });
    const pending = reply.view.inspections.find(pendingInspection);
    assert.ok(pending, "Blocked recipe needs an operator inspection");
    const request = {
      kind: "inspect",
      commandId: `inspect-${pending.task.replaceAll("#", "-").replaceAll("/", "-")}`,
      expectedControlRevision: reply.view.controlRevision,
      task: pending.task,
      definition: pending.definition,
      lots: pending.lots,
      outcome: pending.task.startsWith("load-hazelnut-b#") ? "reject" : "accept",
      note: "Synthetic operator observation for the acceptance journey",
    };
    if (label !== null) {
      const saved = await host.handle({ kind: "save" });
      save(`${label}-inspection-${turn}.json`, saved);
      const wrongMaterial = await host.handle({
        ...request,
        commandId: `wrong-material-${turn}`,
        lots: ["wrong-lot"],
      });
      assert.equal(wrongMaterial.receipt.reason, "inspection_binding_mismatch");
      const stale = await host.handle({
        ...request,
        commandId: `stale-${turn}`,
        expectedControlRevision: reply.view.controlRevision + 1,
      });
      assert.equal(stale.receipt.reason, "stale_control_revision");
      const wrongRevision = await host.handle({
        ...request,
        commandId: `wrong-recipe-${turn}`,
        definition: "0".repeat(64),
      });
      assert.equal(wrongRevision.receipt.reason, "inspection_binding_mismatch");
      for (const id of pending.lots)
        assert.equal(run.lots.find(sameId.bind(null, id)).disposition, "held");
    }
    const admitted = await host.handle(request);
    assert.equal(admitted.kind, "commanded", JSON.stringify(admitted));
    assert.equal(admitted.receipt.status, "accepted", JSON.stringify(admitted));
    const replay = await host.handle(request);
    assert.deepEqual(replay.receipt, admitted.receipt);
    const conflict = await host.handle({
      ...request,
      outcome: request.outcome === "accept" ? "reject" : "accept",
    });
    assert.equal(conflict.receipt.reason, "conflicting_payload");
  }
  throw new Error("Recipe did not settle after its inspections");
}
function recipeTask(run, load, key) {
  const task = run.tasks.find(sameId.bind(null, `${load}#0/${key}`));
  assert.ok(task, `${load}/${key}`);
  return task;
}
function recipeBalance(run) {
  const results = E.runResults(run, {
    after: null,
    through: run.position.time,
  });
  for (const store of results.materialStorageHistory.storages) {
    let occupied = 0;
    let held = 0;
    for (const lot of run.lots) {
      if (lot.holder.kind !== "storage" || lot.holder.storage !== store.storage)
        continue;
      occupied += lot.remaining.amount;
      if (lot.disposition === "held") held += lot.remaining.amount;
    }
    assert.equal(
      store.current.occupied,
      occupied,
      `${store.storage} matches actual stored lots`,
    );
    assert.equal(
      store.current.held,
      held,
      `${store.storage} preserves held material`,
    );
  }
  let remainingMg = 0;
  let exitedMg = 0;
  for (const stock of results.stock)
    if (stock.unit === "milligram") remainingMg += stock.remaining;
  const reported = {};
  for (const entry of results.reported) {
    reported[entry.destination] = entry.amount;
    if (entry.unit === "milligram" && entry.role !== "intermediate-stock")
      exitedMg += entry.amount;
  }
  assert.equal(
    remainingMg + exitedMg,
    775_000,
    "Recipe mass balances at this boundary",
  );
  return { remainingMg, exitedMg, reported, results };
}
function isGridWait(wait) {
  return wait.task === "load-hazelnut-c#0/demould" && wait.blockers.some(isMissingGrid);
}
function isMissingGrid(blocker) {
  return blocker.kind === "carrier" && blocker.store === "empty-grids";
}
async function recipeJourney(gridSlots) {
  const name = `recipe-grid-${gridSlots}`;
  const input = recipeInput(gridSlots);
  const scenario = value(await compileFinancierRecipe(input));
  value(await E.admitScenario(scenario));
  save(`${name}-input.json`, { input, scenario });
  const baselineHost = await open(scenario, null, `${name}-baseline`);
  const baseline = await driveRecipe(
    baselineHost,
    input.preparations[0].horizonSeconds,
    `${name}-baseline`,
  );
  save(`${name}-baseline.json`, baseline);
  assert.equal(
    baseline.status.kind,
    "completed",
    JSON.stringify(baseline.status),
  );
  await baselineHost.handle({ kind: "dispose" });

  const firstBake = recipeTask(baseline, "load-hazelnut-a", "bake");
  const inspection = recipeTask(baseline, "load-hazelnut-a", "examine-bake");
  const returning = recipeTask(baseline, "load-hazelnut-a", "return-mould");
  const thirdCooled = recipeTask(baseline, "load-hazelnut-c", "cool-in-mould");
  const packing = recipeTask(baseline, "load-hazelnut-a", "finish-product");
  const boundaries = [
    firstBake.startedAt,
    inspection.startedAt,
    returning.startedAt,
    thirdCooled.completedAt,
    packing.startedAt,
  ];
  boundaries.sort(compareTimes);
  const stops = [];
  for (const time of new Set(boundaries)) stops.push(time / 1_000_000 + 1);
  let host = await open(scenario, null, `${name}-0`);
  const materialObservations = [];
  for (const [leg, stop] of stops.entries()) {
    const state = await driveRecipe(host, stop, null);
    assert.equal(state.status.kind, "advancing");
    recipeBalance(state);
    materialObservations.push({
      at: state.position.time,
      history: E.observationView(state, state.position.time)
        .materialStorageHistory,
    });
    if (stop === firstBake.startedAt / 1_000_000 + 1) {
      const mould = state.carriers.find(sameId.bind(null, "mould-a"));
      assert.deepEqual(mould.bound, { instance: "load-hazelnut-a#0", role: "mould" });
      assert.deepEqual(mould.custody, {
        kind: "stored",
        storage: "oven-mould",
      });
    }
    if (stop === inspection.startedAt / 1_000_000 + 1) {
      for (const id of ["load-hazelnut-a#0/baked-mass", "load-hazelnut-a#0/baked-pieces"])
        assert.equal(
          state.lots.find(sameId.bind(null, id)).disposition,
          "held",
        );
    }
    save(`${name}-state-${leg}.json`, state);
    const paused = await host.handle({
      kind: "pause",
      commandId: `pause-${leg}`,
    });
    assert.equal(paused.receipt.status, "accepted");
    const saved = await host.handle({ kind: "save" });
    assert.equal(saved.kind, "saved", JSON.stringify(saved));
    save(`${name}-save-${leg}.json`, saved);
    await host.handle({ kind: "dispose" });
    host = await open(scenario, saved, `${name}-${leg + 1}`);
  }
  const continued = await driveRecipe(
    host,
    input.preparations[0].horizonSeconds,
    null,
  );
  assert.deepEqual(history(continued), history(baseline));
  assert.deepEqual(world(continued), world(baseline));
  const result = recipeBalance(continued);
  for (const observation of materialObservations)
    assert.deepEqual(
      E.observationView(continued, observation.at).materialStorageHistory,
      observation.history,
      "Completed history preserves each earlier material-store observation",
    );
  const duringStorage = E.observationView(
    continued,
    575_000_000,
  ).materialStorageHistory.storages.find(materialBatterStore);
  assert.equal(duringStorage.current.occupied, 0);
  assert.deepEqual(duringStorage.current.reservations, [
    { task: "hazelnut-preparation-batches#0/store-batter", quantity: 745_000 },
  ]);
  const beforePortioning = E.observationView(
    continued,
    600_000_000,
  ).materialStorageHistory.storages.find(materialBatterStore);
  assert.equal(beforePortioning.current.occupied, 745_000);
  assert.deepEqual(beforePortioning.current.reservations, []);
  const batterStore =
    result.results.materialStorageHistory.storages.find(materialBatterStore);
  assert.equal(batterStore.current.occupied, 145_000);
  assert.equal(batterStore.fullSeconds, 160);
  save(`${name}-material-observations.json`, {
    materialObservations,
    duringStorage,
    beforePortioning,
    batterStore,
  });
  assert.equal(result.remainingMg, 145_000);
  for (const [destination, amount] of Object.entries({
    "hazelnut-batter-prepared": 745_000,
    "filled-mass": 600_000,
    "filled-pieces": 24,
    "butter-evaporation": 22_000,
    "mixing-residue": 8_000,
    "baking-loss": 36_000,
    "rejected-mass": 188_000,
    "rejected-pieces": 8,
    "sample-mass": 23_500,
    "sample-pieces": 1,
    "packed-mass": 352_500,
    "packed-pieces": 15,
  }))
    assert.equal(result.reported[destination], amount, destination);
  assert.equal(
    recipeTask(continued, "load-hazelnut-c", "prepare-mould").startedAt >=
      returning.completedAt,
    true,
  );
  assert.ok(
    firstBake.startedAt >=
      recipeTask(continued, "financier-preheat", "preheat").completedAt,
  );
  for (const load of input.loads) {
    for (const cavity of load.cavities) {
      const key = `fill-cavity-${cavity.number}`;
      const fill = recipeTask(continued, load.id, key);
      assert.ok(
        fill.startedAt >=
          recipeTask(continued, "hazelnut-preparation-batches", "store-batter")
            .completedAt,
      );
      for (const dimension of ["mass", "piece"]) {
        const id = `${load.id}#0/${key}-${dimension}`;
        const filled = continued.lots.find(sameId.bind(null, id));
        assert.deepEqual(filled.lineage, [
          "hazelnut-preparation-batches#0/prepared-batter",
        ]);
        assert.deepEqual(filled.holder, {
          kind: "carrier",
          carrier: load.mould,
        });
      }
    }
    const bake = recipeTask(continued, load.id, "bake");
    const inspect = recipeTask(continued, load.id, "inspect-bake");
    const demould = recipeTask(continued, load.id, "demould");
    const clean = recipeTask(continued, load.id, "clean-mould");
    assert.ok(inspect.startedAt >= bake.completedAt);
    assert.ok(demould.startedAt >= inspect.completedAt);
    assert.ok(clean.startedAt >= demould.completedAt);
    const finish = recipeTask(continued, load.id, "finish-product");
    assert.ok(
      finish.startedAt >=
        recipeTask(continued, load.id, "pack-ready").completedAt,
    );
    assert.ok(
      finish.startedAt >=
        recipeTask(continued, load.id, "release-for-packing").completedAt,
    );
    if (load.id === "load-hazelnut-b") {
      for (const event of continued.events)
        if (event.kind === "quantity-reported" && event.task === finish.id)
          assert.equal(event.role, "rejected-output");
    }
  }
  assert.equal(result.results.schedulingHistory.kind, "available");
  const gridWaits = result.results.schedulingHistory.waits.filter(isGridWait);
  if (gridSlots === 1)
    assert.ok(gridWaits.length > 0, "One grid blocks the third demoulding");

  for (const resource of result.results.resources) {
    let end = 0;
    for (const interval of resource.intervals) {
      if (interval.kind !== "occupied") continue;
      assert.ok(
        interval.start >= end,
        `${resource.resource} cannot do exclusive work twice`,
      );
      end = interval.end;
    }
  }
  for (const carrier of continued.carriers) {
    assert.equal(carrier.bound, null);
    assert.equal(carrier.custody.kind, "stored");
    const expected = carrier.id.startsWith("grid-")
      ? "empty-grids"
      : `clean-${carrier.id.replace(/-1$/, "")}`;
    assert.equal(carrier.custody.storage, expected);
  }
  save(`${name}-continued.json`, continued);
  save(`${name}-results.json`, result);
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved");
  save(`${name}-final-save.json`, saved);
  await host.handle({ kind: "dispose" });
  const finalHost = await open(scenario, saved, `${name}-final`);
  assert.deepEqual(
    world(await drive(finalHost, input.preparations[0].horizonSeconds)),
    world(continued),
  );
  await finalHost.handle({ kind: "dispose" });
  const refusals = [];
  for (const problem of [
    "duplicate-cavity",
    "outside-mould",
    "unknown-mould",
    "bake-balance",
    "sample-without-mass",
    "missing-inspection",
  ]) {
    const edited = structuredClone(input);
    let code = "invalid_recipe";
    switch (problem) {
      case "duplicate-cavity":
        edited.loads[0].cavities[1].number = 1;
        break;
      case "outside-mould":
        edited.loads[0].cavities[0].number = 9;
        break;
      case "unknown-mould":
        edited.loads[0].mould = "mould-missing";
        break;
      case "bake-balance":
        edited.loads[0].bakedMassMg = 200_000;
        code = "bake_mass_balance";
        break;
      case "sample-without-mass":
        edited.loads[1].inspection.samplePieces = 1;
        break;
      case "missing-inspection":
        delete edited.loads[0].inspection;
        break;
    }
    const refusal = await compileFinancierRecipe(edited);
    assert.deepEqual(refusal, { ok: false, error: { code } });
    refusals.push({ problem, input: edited, refusal });
  }
  save(`${name}-refusals.json`, refusals);
  return {
    name,
    status: continued.status.kind,
    simulatedSeconds: continued.position.time / 1_000_000,
    stops,
    gridWaits,
    packedPieces: 15,
    packedMg: 352_500,
    source: scenario.sources.at(-1),
  };
}

function materialBatterStore(store) {
  return store.storage === "hazelnut-batter-holding";
}
function compareTimes(left, right) {
  return left - right;
}
