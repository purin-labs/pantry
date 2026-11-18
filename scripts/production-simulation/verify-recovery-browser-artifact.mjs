// Verify the downloaded recovery journey without a browser. Resolve the exact
// retained engine, check every byte, and reopen all three saved boundaries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseExecutionBundle,
  parseExecutionManifest,
  resolveExecution,
} from "../../packages/production-simulation/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const retained = join(root, "apps/portal/public/bakery-physics");
assert.equal(process.argv.length, 3, "Provide recovery-session.json.");
const path = resolve(process.argv[2]);
const archive = JSON.parse(readFileSync(path, "utf8"));
const bundle = parseExecutionBundle(archive.reference.bundle);
assert.notEqual(bundle, null, "The archive must name its execution bundle.");
const directory = join(retained, "executions", bundle.id);
const manifest = value(
  await parseExecutionManifest(
    JSON.parse(readFileSync(join(directory, "execution.json"), "utf8")),
  ),
);
value(await resolveExecution(bundle, "browser", [manifest], measure));
const engine = await import(
  pathToFileURL(join(directory, manifest.engine.file)).href
);
const artifacts = new Map();
let byteLength = 0;
for (const artifact of archive.artifacts) {
  assert.equal(typeof artifact.content, "string");
  assert.equal(hash(artifact.content), artifact.digest);
  assert.equal(Buffer.byteLength(artifact.content), artifact.byteLength);
  assert.equal(artifacts.has(artifact.digest), false, "Duplicate artifact.");
  artifacts.set(artifact.digest, artifact);
  byteLength += artifact.byteLength;
}
const documents = [];
for (const save of archive.saves) documents.push(save.document);
documents.push(archive.interrupted.document);
const snapshots = [];
for (const raw of documents) {
  const document = value(await engine.openResumable(raw, "browser", [bundle]));
  for (const entry of document.artifacts) {
    const artifact = artifacts.get(entry.digest);
    assert.ok(artifact, `Missing artifact ${entry.digest}`);
    assert.equal(artifact.byteLength, entry.byteLength);
    assert.equal(artifact.role, entry.role);
  }
  snapshots.push({
    snapshot: document.snapshot,
    time: document.state.position.time,
    status: document.state.status.kind,
  });
}
assert.equal(documents.length, 3);
assert.deepEqual(
  snapshots.map(snapshotTime),
  [31_000_000, 38_000_000, 86_198_000],
);
const final = value(
  await engine.openResumable(archive.interrupted.document, "browser", [bundle]),
);
assert.equal(engine.drainStatus(final.state).kind, "drained");
const results = engine.runResults(final.state, {
  after: null,
  through: final.state.position.time,
});
assert.equal(results.ordersCompleted, 0);
assert.equal(results.orders.filter(isFailed).length, 2);
assert.equal(results.reported.find(isRejected).amount, 2);
assert.deepEqual(world(archive.reference.run), world(final.state));
assert.deepEqual(
  history(archive.reference.run.events),
  history(final.state.events),
);
const report = {
  result: "passed",
  archiveSha256: hash(readFileSync(path)),
  bundle: bundle.id,
  snapshots,
  artifactCount: artifacts.size,
  artifactBytes: byteLength,
  results,
};
writeFileSync(
  join(dirname(path), "recovery-artifact-verification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `Verified ${snapshots.length} snapshots and ${artifacts.size} artifacts (${byteLength} bytes).\n`,
);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function snapshotTime(snapshot) {
  return snapshot.time;
}
function isFailed(order) {
  return order.kind === "failed";
}
function isRejected(output) {
  return output.role === "rejected-output";
}
function world(run) {
  const { identity, commands, events, position, ...state } = run;
  return { ...state, time: position.time };
}
function history(events) {
  const history = [];
  for (const event of events) {
    if (event.kind === "command-admitted") continue;
    const { sequence, execution, command, ...transition } = event;
    history.push(transition);
  }
  return history;
}
async function measure(manifest, file, part) {
  const path =
    part === "engine"
      ? join(retained, "executions", manifest.bundle.id, file.file)
      : join(retained, "bundles", manifest.runtime.id, file.file);
  const bytes = readFileSync(path);
  return { sha256: hash(bytes), byteLength: bytes.byteLength };
}
