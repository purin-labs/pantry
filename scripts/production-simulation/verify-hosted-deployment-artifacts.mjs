import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Verify the immutable documents downloaded from the hosted A-to-B journey.
const directory = resolve(process.argv[2]);
const before = await readFile(resolve(directory, "saved-a.json"));
const after = await readFile(resolve(directory, "saved-b.json"));
const original = await readFile(resolve(directory, "saved-a-after-b.json"));
const report = JSON.parse(
  await readFile(resolve(directory, "report.json"), "utf8"),
);
const source = JSON.parse(before).document.document;
const continued = JSON.parse(after).document.document;
assert.equal(digest(before), report.deploymentA.savedRun.id);
assert.equal(digest(after), report.deploymentB.continuedRunId);
assert.deepEqual(before, original, "The original shared save changed.");
assert.deepEqual(source.bundle, continued.bundle, "The saved engine changed.");
assert.notEqual(source.bundle.id, report.deploymentB.defaultBundle);
assert.deepEqual(
  source.state.events,
  continued.state.events.slice(0, source.state.events.length),
  "The continuation changed accepted history.",
);
assert.deepEqual(continued.state.identity.parent, {
  snapshot: source.snapshot,
  execution: source.state.identity.executionId,
});
assert.equal(source.state.identity.runId, continued.state.identity.runId);
assert.notEqual(
  source.state.identity.executionId,
  continued.state.identity.executionId,
);
assert.notEqual(
  source.state.identity.hostSession,
  continued.state.identity.hostSession,
);
assert.ok(continued.state.position.time > source.state.position.time);
assert.equal(
  continued.state.tasks.find(matchesTask.bind(null, "orders#1/source-transfer"))
    ?.kind,
  "completed",
);
assert.equal(
  continued.state.tasks.find(matchesTask.bind(null, "orders#0/return"))?.kind,
  "completed",
);
for (const cell of source.state.cells) {
  const restored = continued.state.cells.find(matchesCell.bind(null, cell.id));
  assert.ok(restored, `Cell ${cell.id} is missing.`);
  assert.ok(
    restored.committed.checkpoint.step >= cell.committed.checkpoint.step,
  );
}
console.log(
  JSON.stringify(
    {
      passed: true,
      retainedBundle: continued.bundle.id,
      from: source.state.position,
      to: continued.state.position,
      originalUnchanged: true,
      acceptedHistoryPreserved: true,
    },
    null,
    2,
  ),
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function matchesCell(id, cell) {
  return cell.id === id;
}

function matchesTask(id, task) {
  return task.id === id;
}
