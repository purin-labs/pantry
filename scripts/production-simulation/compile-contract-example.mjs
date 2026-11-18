// Plan 70C C0: compiles the recipe contract example through the shared engine
// contracts, admits it, and retains the compiled inputs with each rejected
// branch. run-contract-example.mjs executes the admitted example.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  TICK_MICROSECONDS,
  admitScenario,
} from "../../packages/production-simulation/src/index.ts";
import {
  CONTRACT_EXAMPLE,
  contractExampleAdapter,
  contractExampleSnapshot,
} from "../../packages/production-simulation/src/recipes/contract-example.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

function save(name, value) {
  writeFileSync(join(output, name), `${canonicalJson(value)}\n`);
}

function codes(problems) {
  const result = [];
  for (const problem of problems)
    result.push(problem.code ?? problem.error.code);
  return result;
}

// Baseline: the declared values compile and pass admission unchanged.
const snapshot = await contractExampleSnapshot(CONTRACT_EXAMPLE, 1);
const compiled = contractExampleAdapter.compile(snapshot);
assert.ok(compiled.ok, JSON.stringify(compiled.error));
const admitted = await admitScenario(compiled.value);
assert.ok(admitted.ok, JSON.stringify(admitted.error));
const scenario = admitted.value.scenario;
save("snapshot.json", snapshot);
save("scenario.json", scenario);

// What the compiled form states, derived from it and not from the fixture.
const workflows = new Map();
for (const workflow of scenario.workflows) workflows.set(workflow.id, workflow);
let orders = 0;
let batches = 0;
const batchReleases = [];
for (const source of scenario.arrivals) {
  const workflow = workflows.get(source.workflow);
  for (const arrival of source.arrivals) {
    if (workflow.demand === "order") orders += arrival.quantity;
    if (workflow.id !== "concentrate-batch") continue;
    batches += arrival.quantity;
    batchReleases.push(arrival.time);
  }
}
const batch = workflows.get("concentrate-batch");
const drink = workflows.get("sesame-drink-order");
const lot = batch.tasks[0].outputs[0];
const portion = drink.tasks[0].inputs[0];
assert.equal(lot.product, portion.product);
assert.equal(lot.quantity.unit, portion.quantity.unit);
const portionsPerBatch = lot.quantity.amount / portion.quantity.amount;
const oven = scenario.resources.find(isOven);
const ovenClaims = [];
for (const workflow of scenario.workflows)
  for (const task of workflow.tasks)
    for (const claim of task.claims)
      if (claim.resource === oven.id)
        ovenClaims.push({
          workflow: workflow.id,
          units: claim.units,
          configuration: claim.configuration,
        });
const composition = {
  orders,
  batches,
  batchArrivalsMicroseconds: batchReleases,
  portionsPerBatch,
  ordersBeyondFirstBatch: orders - portionsPerBatch,
  concentrateHeldUntilRelease: lot.disposition === "held",
  concentrateReportingRole: role(lot.report),
  drinkReportingRole: role(drink.tasks[0].outputs[0].destination),
  unconsumedConcentrate: {
    amount: batches * lot.quantity.amount - orders * portion.quantity.amount,
    unit: lot.quantity.unit,
  },
  oven: {
    capacity: oven.capacity,
    initialConfiguration: oven.configuration.initial,
    claims: ovenClaims,
    changeovers: oven.configuration.changeovers.length,
  },
};
assert.equal(composition.orders, 12);
assert.equal(composition.batches, 2);
assert.equal(composition.portionsPerBatch, 10);
assert.equal(composition.ordersBeyondFirstBatch, 2);
assert.ok(composition.batchArrivalsMicroseconds[1] > batchReleases[0]);
assert.equal(composition.concentrateHeldUntilRelease, true);
assert.equal(composition.concentrateReportingRole, "intermediate-stock");
assert.equal(composition.drinkReportingRole, "final-output");
// Both oven tasks fit the oven together, and still cannot share a cycle.
assert.equal(ovenClaims.length, 2);
assert.ok(ovenClaims[0].units + ovenClaims[1].units <= oven.capacity);
assert.notEqual(ovenClaims[0].configuration, ovenClaims[1].configuration);

// Rejected branches. Each alters one declared value or definition.
const rejections = {};

const offGrid = structuredClone(CONTRACT_EXAMPLE);
offGrid.drink.orderArrivalsSeconds[3] += 0.003;
rejections.offGridArrival = contractExampleAdapter.compile(
  await contractExampleSnapshot(offGrid, 2),
);
assert.equal(rejections.offGridArrival.ok, false);
assert.deepEqual(rejections.offGridArrival.error, [
  {
    where: "drink.orderArrivalsSeconds[3]",
    error: {
      code: "off_grid",
      microseconds: 3_060_003_000,
      tickMicroseconds: TICK_MICROSECONDS,
    },
  },
]);

const volume = structuredClone(CONTRACT_EXAMPLE);
volume.drink.milk = { amount: 210, scale: 0, unit: "milliliter" };
rejections.unsupportedConversion = contractExampleAdapter.compile(
  await contractExampleSnapshot(volume, 2),
);
assert.equal(rejections.unsupportedConversion.ok, false);
assert.deepEqual(codes(rejections.unsupportedConversion.error), [
  "unit_mismatch",
]);

const fine = structuredClone(CONTRACT_EXAMPLE);
fine.drink.concentrate = { amount: 760005, scale: 4, unit: "gram" };
rejections.subAccountingQuantity = contractExampleAdapter.compile(
  await contractExampleSnapshot(fine, 2),
);
assert.equal(rejections.subAccountingQuantity.ok, false);
assert.deepEqual(codes(rejections.subAccountingQuantity.error), [
  "unrepresentable",
]);

rejections.noChangeover = await admitScenario({
  ...scenario,
  resources: scenario.resources.map(withoutChangeovers),
});
assert.equal(rejections.noChangeover.ok, false);
assert.deepEqual(codes(rejections.noChangeover.error), [
  "invalid_configuration",
]);
assert.equal(rejections.noChangeover.error[0].reason, "unreachable");

rejections.claimBeyondCapacity = await admitScenario({
  ...scenario,
  resources: scenario.resources.map(withOvenCapacity.bind(null, 1)),
});
assert.equal(rejections.claimBeyondCapacity.ok, false);
assert.deepEqual(codes(rejections.claimBeyondCapacity.error), [
  "claim_exceeds_capacity",
]);

rejections.releaseBeforeProduction = await admitScenario({
  ...scenario,
  workflows: scenario.workflows.map(coolBeforePrepare),
});
assert.equal(rejections.releaseBeforeProduction.ok, false);
assert.deepEqual(codes(rejections.releaseBeforeProduction.error), [
  "invalid_lot",
]);

rejections.finishedDrinkAsIntermediate = await admitScenario({
  ...scenario,
  destinations: scenario.destinations.map(drinkAsIntermediate),
});
assert.equal(rejections.finishedDrinkAsIntermediate.ok, false);
assert.deepEqual(codes(rejections.finishedDrinkAsIntermediate.error), [
  "invalid_report",
]);

// Admission is a pure function of the definition.
const again = await admitScenario(
  contractExampleAdapter.compile(
    await contractExampleSnapshot(CONTRACT_EXAMPLE, 1),
  ).value,
);
assert.equal(again.value.digest, admitted.value.digest);

save("rejections.json", rejections);
save("report.json", {
  plan: "70C C0 — recipe composition contract",
  result: "passed",
  scope: "Compilation and admission. run-contract-example.mjs executes it.",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} <new directory>`,
  node: process.version,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  engineSourceDigest: engineSourceDigest(),
  definitionDigest: admitted.value.digest,
  sourceDigest: snapshot.source.digest,
  tickMicroseconds: TICK_MICROSECONDS,
  composition,
  rejected: Object.fromEntries(Object.entries(rejections).map(rejectionCodes)),
});
console.log(
  `Contract example admitted as ${admitted.value.digest}; artifact in ${output}`,
);

// The package is not yet versioned; its tracked and untracked sources are.
function engineSourceDigest() {
  const directory = join(root, "packages/production-simulation/src");
  const hash = createHash("sha256");
  const files = readdirSync(directory, { recursive: true }).sort();
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(directory, file)));
  }
  return hash.digest("hex");
}

function isOven(resource) {
  return resource.id === "oven";
}

function role(destinationId) {
  for (const destination of scenario.destinations)
    if (destination.id === destinationId) return destination.role;
  throw new Error(`Unknown destination ${destinationId}`);
}

function withoutChangeovers(resource) {
  return resource.configuration === null
    ? resource
    : {
        ...resource,
        configuration: { ...resource.configuration, changeovers: [] },
      };
}

function withOvenCapacity(capacity, resource) {
  return isOven(resource) ? { ...resource, capacity } : resource;
}

function coolBeforePrepare(workflow) {
  if (workflow.id !== "concentrate-batch") return workflow;
  const [prepare, cool] = workflow.tasks;
  return { ...workflow, tasks: [prepare, { ...cool, prerequisites: [] }] };
}

function drinkAsIntermediate(destination) {
  return destination.id === "drinks-served"
    ? { ...destination, role: "intermediate-stock" }
    : destination;
}

function rejectionCodes([name, result]) {
  return [name, codes(result.error)];
}
