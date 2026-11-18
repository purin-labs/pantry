// Plan 84 Journey J7, the engine's part: the one-worker morning shift has late
// orders. The findings name them, typed changes make a proposal through the Worker's
// own functions, and the retained engine runs both. The engine gives every number.
//
//   node --experimental-strip-types scripts/production-simulation/verify-workflow-findings-journey.mjs <fresh dir>
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importScenario } from "../../packages/bakery-workflow/src/index.ts";
import {
  applyWorkflowChanges,
  parseWorkflowChanges,
  proposalChangeSummary,
} from "../../packages/bakery-workflow/src/changes.ts";
import {
  compileDraft,
  draftSeed,
} from "../../packages/bakery-workflow/src/draft.ts";
import {
  lateOrders,
  runFindings,
} from "../../packages/bakery-workflow/src/findings.ts";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  compileBakeryShift,
  morningShiftRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

const output = resolve(process.argv[2] ?? "");
assert.equal(existsSync(output), false, "Choose a fresh evidence directory");
mkdirSync(output, { recursive: true });
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
const cell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});

async function runToEnd(scenario, label) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [cell],
    identity: {
      runId: `findings-${label}`,
      executionId: `findings-${label}`,
      hostSession: `host-${label}`,
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));
  let view = began.view;
  for (let turn = 0; turn < 20_000; turn++) {
    if (view.status.kind === "awaiting-inspection") {
      const pending = view.inspections.find((item) => item.kind === "pending");
      const reply = await host.handle({
        kind: "inspect",
        commandId: `inspect-${turn}`,
        expectedControlRevision: view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome: "accept",
        note: "Comparison",
      });
      assert.equal(
        reply.kind,
        "commanded",
        JSON.stringify(reply).slice(0, 400),
      );
      view = reply.view;
      continue;
    }
    if (["completed", "blocked", "stopped-at-limit"].includes(view.status.kind))
      break;
    const reply = await host.handle({
      kind: "drive",
      turns: 128,
      until: scenario.limits.horizon,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    view = reply.view;
  }
  await host.handle({ kind: "dispose" });
  return view;
}

const input = morningShiftRecipeInput();
input.workers = 1;
const compiled = await compileBakeryShift(input, cell);
assert.equal(compiled.ok, true, JSON.stringify(compiled.error));
const document = importScenario(compiled.value, {
  title: "Morning shift",
  recipe: "bakery-shift",
});
const started = performance.now();
const baseSnapshot = draftSeed(document);
const baseCompile = await compileDraft(document, baseSnapshot);
assert.equal(baseCompile.kind, "ready", JSON.stringify(baseCompile.problems));
const compileMs = Math.round(performance.now() - started);

const applied = await runToEnd(baseCompile.scenario, "applied");
const findings = runFindings(applied, baseCompile.scenario);
const late = lateOrders(applied, baseCompile.scenario);
assert.equal(applied.status.kind, "completed");
// Each review accepts, so no tea is thrown away and six orders are late.
assert.equal(late.length, 6, JSON.stringify(late));
for (const finding of late) assert.ok(finding.id.startsWith("late_order/"));

// One typed change: brown the butter in 2 minutes, not 6, in each financier flavour.
const changes = parseWorkflowChanges(
  ["hazelnut", "coffee", "matcha", "black-sesame"].map((flavour) => ({
    kind: "set_step",
    workflow: `${flavour}-financier-preparation`,
    step: "brown-butter",
    label: null,
    seconds: 120,
    workers: null,
  })),
);
assert.ok(changes);
const proposed = applyWorkflowChanges(document, changes);
assert.equal(proposed.kind, "ready", JSON.stringify(proposed.problems));
const compile = await compileDraft(document, proposed.snapshot);
assert.equal(compile.kind, "ready", JSON.stringify(compile.problems));
const change = proposalChangeSummary(baseSnapshot, draftSeed(compile.document));
assert.deepEqual(change.changed.length, 4);
assert.deepEqual(change.added, []);
const after = await runToEnd(compile.scenario, "proposed");
const lateAfter = lateOrders(after, compile.scenario);
assert.equal(after.status.kind, "completed");
assert.ok(lateAfter.length < late.length, "The change serves more on time");
assert.ok(after.time < applied.time, "The change ends the shift sooner");

// A refused change stores nothing, and it names the step.
const cycle = applyWorkflowChanges(
  document,
  parseWorkflowChanges([
    {
      kind: "connect",
      workflow: "hazelnut-financier-preparation",
      from: "mix",
      to: "brown-butter",
      outcome: null,
    },
  ]),
);
assert.equal(cycle.kind, "ready");
const refused = await compileDraft(document, cycle.snapshot);
assert.equal(refused.kind, "refused");

const report = {
  result: "passed",
  bundle: manifest.bundle.id,
  steps: baseSnapshot.nodes.length,
  compileMilliseconds: compileMs,
  applied: {
    endSeconds: applied.time / 1_000_000,
    lateOrders: late.map((item) => item.subject),
  },
  proposal: {
    change,
    endSeconds: after.time / 1_000_000,
    lateOrders: lateAfter.map((item) => item.subject),
  },
  refusal: refused.problems[0]?.message ?? null,
};
writeFileSync(join(output, "report.json"), `${canonicalJson(report)}\n`);
writeFileSync(
  join(output, "applied-findings.json"),
  `${canonicalJson({ findings })}\n`,
);
console.log(JSON.stringify(report));
