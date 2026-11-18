// Build independent inspection expectations from the accepted recurring journey.
// The browser later reads the original artifacts one at a time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  openResumable,
  readRecordingPack,
} from "../../packages/production-simulation/src/index.ts";
import { nativeIdentity } from "../../packages/production-simulation/src/native/cell-adapter.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide a recurring case reference directory and a fresh evidence directory.",
);
const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: false });
const raw = JSON.parse(readFileSync(join(source, "save-1.json"), "utf8"));
const admitted = await openResumable(raw, "browser", [raw.bundle]);
assert.equal(admitted.ok, true);
const document = admitted.value;
const cells = document.state.cells.map(cellId);
assert.equal(cells.length, 2);
const starts = new Map();
const probes = [];
for (const cell of cells)
  for (const through of [
    0,
    40_000_000,
    700_000_000,
    915_386_000,
    document.state.position.time,
  ])
    probes.push({ cell, through, expected: null });
for (const event of document.state.events) {
  if (event.kind !== "task-started" || event.attempt === null) continue;
  const task = document.state.tasks.find(matchesId.bind(null, event.task));
  assert.equal(task.subject.kind, "workflow");
  const instance = document.state.instances.find(
    matchesId.bind(null, task.subject.instance),
  );
  const workflow = document.state.definition.scenario.workflows.find(
    matchesId.bind(null, instance.workflow),
  );
  const definition = workflow.tasks.find(
    matchesKey.bind(null, task.subject.key),
  );
  assert.equal(definition.executor.kind, "native");
  starts.set(nativeIdentity(event.attempt), {
    task: event.task,
    time: event.time,
    cell: definition.executor.operation.cell,
  });
  if (starts.size <= 4) {
    probes.push({
      cell: definition.executor.operation.cell,
      through: event.time,
      expected: null,
    });
    probes.push({
      cell: definition.executor.operation.cell,
      through: event.time - 2000,
      expected: null,
    });
  }
}
const operations = new Map();
let records = 0;
let bytes = 0;
let packs = 0;
for (const entry of document.artifacts) {
  if (entry.role !== "recording-segment") continue;
  const content = readFileSync(join(source, "artifacts", entry.digest), "utf8");
  assert.equal(hash(content), entry.digest);
  assert.equal(Buffer.byteLength(content), entry.byteLength);
  const decoded = readRecordingPack(content);
  assert.equal(decoded.ok, true);
  packs++;
  bytes += entry.byteLength;
  for (const record of decoded.value.records) {
    records++;
    const text = decoded.value.body.slice(
      record.offset,
      record.offset + record.byteLength,
    );
    const item = JSON.parse(text);
    let cell;
    let at;
    let kind;
    if (item.kind === "accepted-cell-recording") {
      cell = item.cellId;
      at = item.time.kind === "idle" ? item.time.through : item.time.at;
      kind = "cell-recorded";
    } else {
      const start = starts.get(item.attemptId);
      assert.ok(start);
      cell = start.cell;
      at = start.time + item.endStep * 2000;
      kind = "recorded";
      const operation = operations.get(start.task) ?? {
        task: start.task,
        cell,
        digests: [],
        packs: new Set(),
        bytes: 0,
      };
      operation.digests.push(record.digest);
      operation.packs.add(entry.digest);
      operation.bytes += record.byteLength;
      operations.set(start.task, operation);
    }
    for (const probe of probes)
      if (
        probe.cell === cell &&
        at <= probe.through &&
        (probe.expected === null || at >= probe.expected.at)
      )
        probe.expected = { digest: record.digest, at, kind };
  }
}
let operation = null;
for (const candidate of operations.values())
  if (candidate.packs.size > 1 && candidate.bytes < 64 * 1024 * 1024) {
    operation = {
      task: candidate.task,
      cell: candidate.cell,
      records: candidate.digests.length,
      digest: hash(candidate.digests.join("\n")),
      packs: candidate.packs.size,
    };
    break;
  }
assert.ok(operation, "Choose an operation that crosses pack boundaries.");
assert.ok(records > 65_536);
writeFileSync(
  join(output, "expected.json"),
  JSON.stringify(
    {
      source,
      snapshot: document.snapshot,
      packs,
      records,
      bytes,
      probes,
      operation,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    output,
    packs,
    records,
    bytes,
    probes: probes.length,
    operation,
  }),
);
function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}
function cellId(cell) {
  return cell.id;
}
function matchesId(id, item) {
  return item.id === id;
}
function matchesKey(key, item) {
  return item.key === key;
}
