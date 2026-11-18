import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  parseRehearsalWorkcells,
  exportRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import {
  prepareRehearsalReview,
  prepareRehearsalEdit,
} from "../../apps/portal/src/features/workflow-simulator/rehearsal-edits.ts";
import {
  initialSimulatorState,
  applyBakeryWorkspaceAction,
} from "../../apps/portal/src/features/workflow-simulator/simulator-state.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide a completed two-tray run and evidence directory.",
);
const parsed = await parseRehearsalWorkcells(
  readFileSync(process.argv[2], "utf8"),
);
assert.equal(parsed.kind, "ready", parsed.message);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const before = parsed.plan;
let state = applyBakeryWorkspaceAction(
  {
    kind: "openRehearsalRun",
    plan: before,
    notice: "Concurrent ingredient edit acceptance",
  },
  initialSimulatorState("closed"),
);
// Two editors and an agent prepare from the same accepted revision.
const first = await prepareRehearsalEdit(before, {
  kind: "ingredients",
  batchId: "A",
  ingredients: { massKg: 0.5, forwardMm: 0, lateralMm: 0 },
});
const second = await prepareRehearsalEdit(before, {
  kind: "ingredients",
  batchId: "A",
  ingredients: { massKg: 0.75, forwardMm: 0, lateralMm: 0 },
});
const agent = await prepareRehearsalReview(before, {
  kind: "set_ingredients",
  batchId: "A",
  ingredients: { massKg: 1, forwardMm: 100, lateralMm: 60 },
});
assert.equal(first.kind, "ready");
assert.equal(second.kind, "ready");
assert.equal(agent.kind, "ready");
state = applyBakeryWorkspaceAction(
  { kind: "rehearsalEdited", edit: first.edit },
  state,
);
assert.equal(state.workspace.production.data.plan, first.edit.plan);
assert.equal(
  applyBakeryWorkspaceAction(
    { kind: "rehearsalEdited", edit: second.edit },
    state,
  ),
  state,
);
assert.equal(
  applyBakeryWorkspaceAction(
    { kind: "rehearsalReviewPrepared", review: agent.review },
    state,
  ),
  state,
);
const unaffectedBefore = before.operations.filter(otherTray);
const unaffectedAfter =
  state.workspace.production.data.plan.operations.filter(otherTray);
assert.deepEqual(unaffectedAfter, unaffectedBefore);
const fresh = await prepareRehearsalReview(
  state.workspace.production.data.plan,
  {
    kind: "set_ingredients",
    batchId: "A",
    ingredients: { massKg: 0.75, forwardMm: 0, lateralMm: 0 },
  },
);
assert.equal(fresh.kind, "ready");
const reviewed = applyBakeryWorkspaceAction(
  { kind: "rehearsalReviewPrepared", review: fresh.review },
  state,
);
assert.equal(reviewed.workspace.production.rehearsalReview, fresh.review);
// A real job transition can arrive while an asynchronous editor is preparing.
for (const kind of ["loading", "running"]) {
  const busy = structuredClone(state);
  busy.browserJob = { kind, generation: 1, operationId: "batch:A:native:1" };
  const edit = await prepareRehearsalEdit(busy.workspace.production.data.plan, {
    kind: "ingredients",
    batchId: "A",
    ingredients: { massKg: 0.75, forwardMm: 0, lateralMm: 0 },
  });
  assert.equal(edit.kind, "ready");
  assert.equal(
    applyBakeryWorkspaceAction(
      { kind: "rehearsalEdited", edit: edit.edit },
      busy,
    ),
    busy,
  );
}
const accepted = applyBakeryWorkspaceAction(
  { kind: "rehearsalReviewResolved", review: fresh.review, decision: "apply" },
  reviewed,
);
assert.equal(
  accepted.workspace.production.data.plan.operations[0].attempt.input.request
    .ingredients.massKg,
  0.75,
);
const saved = exportRehearsalWorkcells(accepted.workspace.production.data.plan);
writeFileSync(join(output, "saved.json"), saved);
const restored = await parseRehearsalWorkcells(saved);
assert.equal(restored.kind, "ready");
assert.equal(
  restored.plan.fingerprint,
  accepted.workspace.production.data.plan.fingerprint,
);
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      scope:
        "two editor snapshots and agent review through the shared workspace commit boundary",
      checks: [
        "second writer rejected after first commit",
        "stale agent review rejected",
        "unaffected tray results preserved",
        "loading and running reject edits",
        "fresh reviewed edit applies",
        "saved run restores",
      ],
    },
    null,
    2,
  ) + "\n",
);
function otherTray(operation) {
  return operation.batchId === "B";
}
console.log("Concurrent ingredient edit acceptance passed.");
