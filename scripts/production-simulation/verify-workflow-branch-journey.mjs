// Plan 84 Journeys J5 and J6: decision branches, on the retained engine, with real
// Rust/MuJoCo cells where a recipe has them. Each draft goes through the canvas's
// own compile. The engine's events give every outcome below.
//
//   node --experimental-strip-types scripts/production-simulation/verify-workflow-branch-journey.mjs OUTPUT
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importScenario } from "../../packages/bakery-workflow/src/index.ts";
import {
  compileDraft,
  draftSeed,
  newStepNode,
  withDecisionRule,
} from "../../packages/bakery-workflow/src/draft.ts";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-milk-tea.ts";
import { compileLatte } from "../../packages/production-simulation/src/recipes/bakery/latte.ts";
import {
  compilePourOver,
  parsePourOverRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/pour-over.ts";
import { parseNativeCell } from "../../packages/production-simulation/src/native/cell-adapter.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

const OLD_BUNDLE =
  "8f9d71291cecf1ff2704f682d8d33d01f4b938575431d18994d6671e300a2afa";
const output = resolve(process.argv[2] ?? "");
assert.equal(existsSync(output), false, "Choose a fresh evidence directory");
mkdirSync(output, { recursive: true });

const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
);
const engineFile = (bundle) =>
  pathToFileURL(
    resolve(
      `apps/portal/public/bakery-physics/executions/${bundle}/production-engine.mjs`,
    ),
  ).href;
const E = await import(engineFile(manifest.bundle.id));
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
function isPending(item) {
  return item.kind === "pending";
}

async function open(
  engine,
  bundle,
  origin,
  cells,
  leg,
  parent = null,
  runtimeDirectory = runtime,
) {
  const host = collectingExecutionHost(
    engine,
    engine.wasmTransport(await runtimeModule(runtimeDirectory), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle,
    cells,
    identity: {
      runId: "workflow-branch-journey",
      executionId: `branch-${leg}`,
      hostSession: `host-${leg}`,
      parent,
    },
    origin,
  });
  return { host, began };
}

/** Drives to the end, or until `stopAt` says that this review should wait. */
async function drive(host, scenario, decide, stopAt, leg) {
  let reviews = 0;
  for (let turn = 0; turn < 20_000; turn++) {
    const reply = await host.handle({
      kind: "drive",
      turns: 128,
      until: scenario.limits.horizon,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    const status = reply.view.status.kind;
    if (status === "awaiting-inspection") {
      const pending = reply.view.inspections.find(isPending);
      assert.ok(pending);
      if (stopAt?.(pending.task) === true) return { stopped: pending.task };
      const answer = await host.handle({
        kind: "inspect",
        commandId: `${leg}-review-${reviews++}`,
        expectedControlRevision: reply.view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome: decide(pending.task),
        note: "Plan 84 branch journey",
      });
      assert.equal(answer.receipt.status, "accepted", JSON.stringify(answer));
      continue;
    }
    if (["completed", "blocked", "stopped-at-limit"].includes(status)) {
      const state = await host.handle({ kind: "state" });
      return { run: state.run };
    }
  }
  throw new Error(`${leg} exceeded its execution bound`);
}

async function runScenario(scenario, cells, decide, leg) {
  const { host, began } = await open(
    E,
    manifest.bundle,
    { kind: "scenario", scenario },
    cells,
    leg,
  );
  assert.equal(began.kind, "began", JSON.stringify(began));
  const { run } = await drive(host, scenario, decide, null, leg);
  await host.handle({ kind: "dispose" });
  return run;
}

function eventsOf(run, kind, key) {
  return run.events.filter(
    (event) => event.kind === kind && event.task?.endsWith(`/${key}`),
  );
}
/** A run's events without the identity of its host or its command IDs. */
/**
 * The events of a run without their execution identities. Across engine
 * releases (`acrossReleases`), a checkpoint digest also differs, because the
 * checkpoint names its engine; there the times, boundaries and outcomes must
 * still be equal.
 */
function plainEvents(run, acrossReleases = false) {
  const events = [];
  for (const event of run.events) {
    const {
      execution: _execution,
      command: _command,
      commandId: _id,
      ...rest
    } = event;
    if (acrossReleases) delete rest.checkpoint;
    events.push(rest);
  }
  return events;
}
async function digestOf(run, acrossReleases = false) {
  return sha256Hex(canonicalJson(plainEvents(run, acrossReleases)));
}
function firstDifference(left, right, acrossReleases = false) {
  const one = plainEvents(left, acrossReleases);
  const two = plainEvents(right, acrossReleases);
  for (let index = 0; index < Math.max(one.length, two.length); index++) {
    const a = canonicalJson(one[index] ?? null);
    const b = canonicalJson(two[index] ?? null);
    if (a !== b) return `${index}: ${a.slice(0, 300)} | ${b.slice(0, 300)}`;
  }
  return null;
}
function endOf(run) {
  return run.events.at(-1).time;
}

/** A draft that a person would make on the canvas, through its own functions. */
function edited(document, change) {
  const snapshot = draftSeed(document);
  const nodes = [...snapshot.nodes];
  const edges = [...snapshot.edges];
  change({ nodes, edges, snapshot: { ...snapshot, nodes, edges } });
  return { ...snapshot, nodes, edges };
}
function addNode(document, draft, workflow, kind, label, seconds) {
  const node = newStepNode(
    document,
    { ...draft.snapshot, nodes: draft.nodes, edges: draft.edges },
    { workflow, kind, label, seconds },
  );
  assert.ok(node);
  draft.nodes.push(node);
  return node;
}
function connect(draft, workflow, from, to, branch = null) {
  draft.edges.push({
    workflow,
    from,
    to,
    order: draft.edges.length + 1000,
    branch,
  });
}
async function ready(document, snapshot) {
  const compiled = await compileDraft(document, snapshot);
  assert.equal(compiled.kind, "ready", JSON.stringify(compiled.problems));
  return compiled;
}

const report = {};

// ---- J5: a person's decision with a re-simmer arm and a join, on the real pan cell.
const panCell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});
const teaScenario = value(
  await compileGingerMilkTeaRecipe(gingerMilkTeaRecipeInput(), panCell),
);
const tea = importScenario(teaScenario, {
  title: "Ginger milk tea",
  recipe: "ginger-milk-tea",
});
const TEA = "ginger-milk-tea-batch";

// An unedited draft keeps the compiler's digest: decisions change nothing else.
const unedited = await ready(tea, draftSeed(tea));
assert.equal(
  unedited.digest,
  value(await E.admitScenario(teaScenario)).digest,
  "An unedited draft changed its digest.",
);

const branched = edited(tea, (draft) => {
  const decision = addNode(tea, draft, TEA, "decision", "Strong enough?", 1);
  const again = addNode(tea, draft, TEA, "wait", "Simmer again", 60);
  connect(draft, TEA, "simmer-ginger", decision.key);
  connect(draft, TEA, decision.key, again.key, "reject");
  connect(draft, TEA, again.key, "add-tea");
  connect(draft, TEA, decision.key, "add-tea");
});
const teaDraft = await ready(tea, branched);
function teaDecision(outcome) {
  return (task) => (task.endsWith("/strong-enough") ? outcome : "accept");
}
const teaAccept = await runScenario(
  teaDraft.scenario,
  [panCell],
  teaDecision("accept"),
  "tea-accept",
);
const teaReject = await runScenario(
  teaDraft.scenario,
  [panCell],
  teaDecision("reject"),
  "tea-reject",
);
assert.equal(teaAccept.status.kind, "completed");
assert.equal(teaReject.status.kind, "completed");
assert.ok(
  eventsOf(teaAccept, "task-skipped", "simmer-again").length > 0,
  "An accepted decision ran the re-simmer arm.",
);
assert.equal(eventsOf(teaAccept, "task-completed", "simmer-again").length, 0);
assert.ok(eventsOf(teaReject, "task-completed", "simmer-again").length > 0);
assert.equal(eventsOf(teaReject, "task-skipped", "simmer-again").length, 0);
// Two batches, and the join runs once for each.
for (const run of [teaAccept, teaReject])
  assert.equal(
    eventsOf(run, "task-completed", "add-tea").length,
    eventsOf(run, "task-completed", "simmer-ginger").length,
    "The join did not run once for each batch.",
  );
assert.ok(endOf(teaReject) > endOf(teaAccept), "The arm added no time.");

// Reopen at the decision in a fresh session, and the run continues exactly.
{
  const { host, began } = await open(
    E,
    manifest.bundle,
    { kind: "scenario", scenario: teaDraft.scenario },
    [panCell],
    "tea-first",
  );
  assert.equal(began.kind, "began");
  const paused = await drive(
    host,
    teaDraft.scenario,
    teaDecision("reject"),
    (task) => task.endsWith("/strong-enough"),
    "tea-first",
  );
  assert.ok(paused.stopped);
  const saved = await host.handle({ kind: "save" });
  await host.handle({ kind: "dispose" });
  const { host: reopened, began: resumed } = await open(
    E,
    manifest.bundle,
    {
      kind: "snapshot",
      document: saved.document,
      checkpoints: saved.artifacts,
    },
    [panCell],
    "tea-second",
    {
      snapshot: saved.document.snapshot,
      execution: saved.document.state.identity.executionId,
    },
  );
  assert.equal(resumed.kind, "began", JSON.stringify(resumed));
  const { run } = await drive(
    reopened,
    teaDraft.scenario,
    teaDecision("reject"),
    null,
    "tea-second",
  );
  await reopened.handle({ kind: "dispose" });
  assert.equal(run.status.kind, "completed");
  const differing = firstDifference(run, teaReject);
  assert.equal(differing, null, `Reopen changed the run: ${differing}`);
}

// A tray move inside an arm is refused before Run, and names the step.
const trayInArm = edited(tea, (draft) => {
  const decision = addNode(tea, draft, TEA, "decision", "Stage it?", 1);
  connect(draft, TEA, "prepare-ginger-and-water", decision.key);
  const index = draft.edges.findIndex(
    (edge) => edge.to === "place-pan-a-on-hob",
  );
  draft.edges.splice(index, 1);
  connect(draft, TEA, decision.key, "place-pan-a-on-hob", "accept");
});
const refusedTray = await compileDraft(tea, trayInArm);
assert.equal(refusedTray.kind, "refused");
assert.ok(
  refusedTray.problems.some((problem) =>
    problem.message.includes("place-pan-a-on-hob"),
  ),
  JSON.stringify(refusedTray.problems),
);
report.j5 = {
  acceptEnd: endOf(teaAccept),
  rejectEnd: endOf(teaReject),
  skippedOnAccept: eventsOf(teaAccept, "task-skipped", "simmer-again").length,
  ranOnReject: eventsOf(teaReject, "task-completed", "simmer-again").length,
  trayRefusal: refusedTray.problems.map((problem) => problem.message),
};

// ---- J6: nested and scripted decisions need no person, and two runs agree.
const latte = importScenario(await compileLatte({ revision: 1, milkG: 180 }), {
  title: "Latte",
  recipe: "latte",
});
const LATTE = "latte-order";
function nested(first, second) {
  return edited(latte, (draft) => {
    const outer = addNode(latte, draft, LATTE, "decision", "Foam ok", 1);
    outer.body = withDecisionRule(outer.body, {
      kind: "scripted",
      outcomes: first,
    });
    const inner = addNode(latte, draft, LATTE, "decision", "Rework or bin", 1);
    inner.body = withDecisionRule(inner.body, {
      kind: "scripted",
      outcomes: second,
    });
    const extra = addNode(latte, draft, LATTE, "wait", "Steam again", 9);
    connect(draft, LATTE, "steam-whirlpool", outer.key);
    connect(draft, LATTE, outer.key, inner.key, "reject");
    connect(draft, LATTE, inner.key, extra.key, "reject");
    connect(draft, LATTE, extra.key, "pour-latte");
    connect(draft, LATTE, outer.key, "pour-latte");
    connect(draft, LATTE, inner.key, "pour-latte");
  });
}
function neverAsked(task) {
  throw new Error(`A scripted decision asked a person: ${task}`);
}
const matrix = {};
for (const [name, first, second, innerRuns, extraRuns] of [
  ["accept", ["accept"], ["reject"], false, false],
  ["reject-accept", ["reject"], ["accept"], true, false],
  ["reject-reject", ["reject"], ["reject"], true, true],
]) {
  const compiled = await ready(latte, nested(first, second));
  const one = await runScenario(compiled.scenario, [], neverAsked, `${name}-1`);
  const two = await runScenario(compiled.scenario, [], neverAsked, `${name}-2`);
  assert.equal(one.status.kind, "completed");
  assert.equal(
    await digestOf(one),
    await digestOf(two),
    `${name}: runs differ`,
  );
  assert.equal(eventsOf(one, "decision-taken", "foam-ok").length, 1);
  assert.equal(
    eventsOf(one, "decision-taken", "rework-or-bin").length,
    innerRuns ? 1 : 0,
    `${name}: the inner decision`,
  );
  assert.equal(
    eventsOf(one, "task-completed", "steam-again").length,
    extraRuns ? 1 : 0,
    `${name}: the inner arm`,
  );
  assert.equal(
    eventsOf(one, "task-skipped", "steam-again").length,
    extraRuns ? 0 : 1,
  );
  assert.equal(eventsOf(one, "task-completed", "pour-latte").length, 1);
  matrix[name] = { end: endOf(one), digest: await digestOf(one) };
}
assert.ok(matrix["reject-reject"].end > matrix.accept.end);
report.j6 = { nested: matrix };

// A nested run reopens too: the restore checks accept a skip inside a skip.
{
  const compiled = await ready(latte, nested(["accept"], ["reject"]));
  const { host, began } = await open(
    E,
    manifest.bundle,
    { kind: "scenario", scenario: compiled.scenario },
    [],
    "nested-first",
  );
  assert.equal(began.kind, "began");
  const stop = compiled.scenario.limits.horizon;
  const reply = await host.handle({ kind: "drive", turns: 128, until: stop });
  assert.equal(reply.kind, "drove");
  const saved = await host.handle({ kind: "save" });
  await host.handle({ kind: "dispose" });
  const { began: resumed, host: reopened } = await open(
    E,
    manifest.bundle,
    {
      kind: "snapshot",
      document: saved.document,
      checkpoints: saved.artifacts,
    },
    [],
    "nested-second",
    {
      snapshot: saved.document.snapshot,
      execution: saved.document.state.identity.executionId,
    },
  );
  assert.equal(resumed.kind, "began", JSON.stringify(resumed));
  await reopened.handle({ kind: "dispose" });
}

// A measured value decides, on the real pour-over cell.
const pourOverRecipe = parsePourOverRecipe({
  revision: 1,
  kettleWaterG: 500,
  drainage: "nominal",
  fault: "none",
});
const pourCell = await prepareCell(runtime, "pour-over-cell", {
  fixture: "pour-over",
  kettleWaterG: 500,
  drainage: "nominal",
  fault: "none",
});
const pourScenario = await compilePourOver(
  pourOverRecipe,
  value(parseNativeCell(pourCell)),
);
const pour = importScenario(pourScenario, {
  title: "Pour-over",
  recipe: "pour-over",
});
const measuredTask = pour.workflows
  .flatMap((workflow) =>
    workflow.nodes.map((node) => ({ workflow: workflow.id, node })),
  )
  .find(({ node }) =>
    node.body.outputs.some((item) => item.kind === "measured-lot"),
  );
if (measuredTask !== undefined) {
  const measured = measuredTask.node.body.outputs.find(
    (item) => item.kind === "measured-lot",
  );
  const withRule = (minimum, maximum) =>
    edited(pour, (draft) => {
      const decision = addNode(
        pour,
        draft,
        measuredTask.workflow,
        "decision",
        "Yield ok",
        1,
      );
      decision.body = withDecisionRule(decision.body, {
        kind: "measurement",
        lot: measured.lot,
        minimum,
        maximum,
      });
      const extra = addNode(
        pour,
        draft,
        measuredTask.workflow,
        "wait",
        "Brew again",
        5,
      );
      connect(draft, measuredTask.workflow, measuredTask.node.id, decision.key);
      connect(draft, measuredTask.workflow, decision.key, extra.key, "reject");
    });
  const inRange = await ready(pour, withRule(0, Number.MAX_SAFE_INTEGER));
  const outOfRange = await ready(pour, withRule(1, 2));
  const yes = await runScenario(
    inRange.scenario,
    [pourCell],
    neverAsked,
    "pour-in",
  );
  const no = await runScenario(
    outOfRange.scenario,
    [pourCell],
    neverAsked,
    "pour-out",
  );
  assert.equal(yes.status.kind, "completed");
  assert.equal(no.status.kind, "completed");
  assert.equal(eventsOf(yes, "task-completed", "brew-again").length, 0);
  assert.equal(eventsOf(no, "task-completed", "brew-again").length, 1);
  report.j6.measured = {
    lot: measured.lot,
    inRange: "accept",
    outOfRange: "reject",
  };
} else
  report.j6.measured =
    "No recipe output is a measured lot in this pour-over build.";

// ---- J6: the retained bundle still runs its own runs, and refuses what it cannot.
const oldEngine = await import(engineFile(OLD_BUNDLE));
const oldManifest = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(
    resolve(
      `apps/portal/public/bakery-physics/executions/${OLD_BUNDLE}/execution.json`,
    ),
    "utf8",
  ),
);
// The retained bundle runs on its own runtime, with a cell that its runtime
// defines: a cell of the present runtime names another build.
const oldRuntime = resolve(
  `apps/portal/public/bakery-physics/bundles/${oldManifest.runtime.id}`,
);
const oldPanCell = await prepareCell(oldRuntime, "tea-pan-cell", {
  fixture: "pan-staging",
});
const oldTeaScenario = value(
  await compileGingerMilkTeaRecipe(gingerMilkTeaRecipeInput(), oldPanCell),
);
{
  const { host, began } = await open(
    oldEngine,
    oldManifest.bundle,
    { kind: "scenario", scenario: oldTeaScenario },
    [oldPanCell],
    "old-first",
    null,
    oldRuntime,
  );
  assert.equal(began.kind, "began", JSON.stringify(began));
  const paused = await drive(
    host,
    oldTeaScenario,
    teaDecision("accept"),
    (task) => task.endsWith("/inspect-strained-tea"),
    "old-first",
  );
  assert.ok(paused.stopped, "The old engine did not reach its review.");
  const saved = await host.handle({ kind: "save" });
  await host.handle({ kind: "dispose" });
  const { host: reopened, began: resumed } = await open(
    oldEngine,
    oldManifest.bundle,
    {
      kind: "snapshot",
      document: saved.document,
      checkpoints: saved.artifacts,
    },
    [oldPanCell],
    "old-second",
    {
      snapshot: saved.document.snapshot,
      execution: saved.document.state.identity.executionId,
    },
    oldRuntime,
  );
  assert.equal(resumed.kind, "began", JSON.stringify(resumed));
  const { run } = await drive(
    reopened,
    oldTeaScenario,
    teaDecision("accept"),
    null,
    "old-second",
  );
  await reopened.handle({ kind: "dispose" });
  assert.equal(run.status.kind, "completed");
  const current = await runScenario(
    teaScenario,
    [panCell],
    teaDecision("accept"),
    "new",
  );
  assert.equal(
    await digestOf(run, true),
    await digestOf(current, true),
    `The new engine changed a recipe with no new decision. First difference: ${firstDifference(run, current, true)}`,
  );
  report.j6.retainedBundle = {
    old: OLD_BUNDLE,
    resumed: true,
    sameEventsOnNewEngine: true,
  };
}
const refusedOld = await oldEngine
  .admitScenario(teaDraft.scenario)
  .catch((error) => ({ ok: false, error: String(error) }));
assert.equal(
  refusedOld.ok,
  false,
  "The old engine admitted a decision with no lot.",
);
report.j6.oldEngineRefusesNewDecision = true;

writeFileSync(join(output, "report.json"), `${canonicalJson(report)}\n`);
console.log(JSON.stringify(report).slice(0, 1800));
console.log(`J5 and J6 passed. Evidence: ${output}`);
