// Read the browser's downloaded run, resolve its retained build, and verify both
// saved boundaries against the uninterrupted headless case.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseExecutionBundle,
  parseExecutionManifest,
  resolveExecution,
} from "../../packages/production-simulation/src/index.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide browser evidence and headless case directories.",
);
const directory = resolve(process.argv[2]);
const referenceDirectory = resolve(process.argv[3], "reference");
const retained = resolve("apps/portal/public/bakery-physics");
// A complete JSON archive can exceed V8's single-string limit. Python is only
// an offline JSON extractor here; the retained engine validates all run state.
const extracted = mkdtempSync(join(tmpdir(), "satyr-recurring-artifacts-"));
process.on("exit", removeExtracted);
const archive = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `
import json, pathlib, re, sys
with open(sys.argv[1]) as source:
    archive = json.load(source)
entries = []
seen = set()
for artifact in archive["artifacts"]:
    digest = artifact["digest"]
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert digest not in seen
    seen.add(digest)
    path = pathlib.Path(sys.argv[2]) / digest
    path.write_text(artifact["content"], encoding="utf-8")
    entries.append({"digest": digest, "path": str(path)})
print(json.dumps({"kind": archive["kind"], "document": archive["document"], "artifacts": entries}))
`,
      join(directory, "recurring-run.json"),
      extracted,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
const journey = readJson(join(directory, "report.json"));
assert.equal(journey.result, "passed");
assert.equal(archive.kind, "saved");
const bundle = parseExecutionBundle(archive.document.bundle);
assert.notEqual(bundle, null);
const manifest = value(
  await parseExecutionManifest(
    readJson(join(retained, "executions", bundle.id, "execution.json")),
  ),
);
value(await resolveExecution(bundle, "browser", [manifest], measure));
const engine = await import(
  pathToFileURL(join(retained, "executions", bundle.id, manifest.engine.file))
    .href
);
const artifacts = new Map();
let records = 0;
let recordingBytes = 0;
let historicalPackChecked = false;
for (const artifact of archive.artifacts) {
  assert.equal(artifacts.has(artifact.digest), false);
  artifacts.set(artifact.digest, artifact.path);
}
const document = value(
  await engine.openResumable(archive.document, "browser", [bundle]),
);
assert.equal(artifacts.size, document.artifacts.length);
for (const entry of document.artifacts) {
  const path = artifacts.get(entry.digest);
  assert.equal(typeof path, "string");
  const content = readFileSync(path, "utf8");
  assert.equal(hash(content), entry.digest);
  assert.equal(Buffer.byteLength(content), entry.byteLength);
  if (entry.role !== "recording-segment") continue;
  const decoded = value(engine.readRecordingPack(content));
  for (const record of decoded.records)
    assert.equal(
      hash(
        decoded.body.slice(record.offset, record.offset + record.byteLength),
      ),
      record.digest,
    );
  records += decoded.records.length;
  recordingBytes += entry.byteLength;
  if (!historicalPackChecked) {
    // Exercise the persistence conversion with exact bytes from a native run.
    const historical = `${JSON.stringify({ kind: "recording-pack", schemaVersion: 1, records: decoded.records })}\n${decoded.body}`;
    assert.deepEqual(value(engine.readRecordingPack(historical)), decoded);
    historicalPackChecked = true;
  }
}
const restoredSnapshots = [];
for (const point of journey.checks.restorePoints) {
  const saved = value(
    await engine.openResumable(point.document, "browser", [bundle]),
  );
  const checkpoints = new Map();
  for (const entry of point.checkpoints)
    checkpoints.set(entry.digest, entry.content);
  for (const entry of saved.artifacts) {
    const content =
      entry.role === "cell-checkpoint"
        ? checkpoints.get(entry.digest)
        : readFileSync(artifacts.get(entry.digest), "utf8");
    assert.equal(typeof content, "string");
    assert.equal(hash(content), entry.digest);
    assert.equal(Buffer.byteLength(content), entry.byteLength);
  }
  restoredSnapshots.push(saved.snapshot);
}
const reference = readJson(join(referenceDirectory, "save-1.json"));
assert.deepEqual(history(document.state), history(reference.state));
assert.deepEqual(world(document.state), world(reference.state));
assert.deepEqual(checkpoints(document), checkpoints(reference));
assert.equal(document.state.status.kind, "completed");
const results = engine.runResults(document.state, {
  after: null,
  through: document.state.position.time,
});
assert.equal(results.ordersCompleted, 24);
for (const carrier of document.state.carriers) {
  assert.equal(carrier.bound, null);
  assert.deepEqual(carrier.custody, { kind: "stored", storage: "tray-store" });
}
const report = {
  result: "passed",
  bundle: bundle.id,
  finalSnapshot: document.snapshot,
  restoredSnapshots,
  artifactCount: artifacts.size,
  recordingBytes,
  exactRecords: records,
  historicalPackChecked,
  sameEventsAndWorld: true,
  sameTerminalNativeCheckpoints: true,
};
writeFileSync(
  join(directory, "artifact-verification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));

function removeExtracted() {
  rmSync(extracted, { recursive: true, force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
async function measure(manifest, file, part) {
  const path =
    part === "engine"
      ? join(retained, "executions", manifest.bundle.id, file.file)
      : join(retained, "bundles", manifest.runtime.id, file.file);
  const bytes = readFileSync(path);
  return { sha256: hash(bytes), byteLength: bytes.byteLength };
}
function history(run) {
  const events = [];
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (event.kind !== "command-admitted") events.push(event);
  return events;
}
function world(run) {
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    position,
    ...state
  } = run;
  return { ...state, time: position.time };
}
function checkpoints(document) {
  const entries = [];
  for (const entry of document.artifacts)
    if (entry.role === "cell-checkpoint") entries.push(entry);
  return entries;
}
