// Exercise backpressure against a real Wasm cell, then prepare the unchanged
// 24-order congestion fixture for the browser storage and restore journey.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildExecutionBundle,
  runtimeModule,
} from "./build-execution-bundle.mjs";

assert.equal(
  process.argv.length,
  5,
  "Provide the accepted recurring case, runtime directory and fresh output directory.",
);
const source = resolve(process.argv[2]);
const runtime = resolve(process.argv[3]);
const output = resolve(process.argv[4]);
mkdirSync(output, { recursive: false });
const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const scenario = JSON.parse(
  readFileSync(join(source, "scenario.json"), "utf8"),
);
const cells = JSON.parse(readFileSync(join(source, "cells.json"), "utf8"));
const module = await runtimeModule(runtime);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const host = E.createExecutionHost(
  E.wasmTransport(module, {
    encode: encoder.encode.bind(encoder),
    decode: decoder.decode.bind(decoder),
  }),
);
assert.equal(host.protocolVersion, E.HOST_PROTOCOL_VERSION);
const begin = await host.handle({
  kind: "begin",
  bundle: built.manifest.bundle,
  cells,
  identity: {
    runId: "artifact-handoff",
    executionId: "execution-1",
    hostSession: "host-1",
    parent: null,
  },
  origin: { kind: "scenario", scenario },
});
assert.equal(begin.kind, "began", JSON.stringify(begin));
let offered;
for (;;) {
  const reply = await host.handle({
    kind: "drive",
    turns: 512,
    until: 700_000_000,
  });
  assert.equal(reply.kind, "drove", JSON.stringify(reply));
  offered = await host.handle({ kind: "artifact", acknowledged: null });
  assert.equal(offered.kind, "artifact");
  if (offered.artifact !== null) break;
  assert.ok(
    reply.view.time < 700_000_000,
    "The run must produce a recording pack",
  );
}
const before = await host.handle({ kind: "state" });
assert.equal(
  (await host.handle({ kind: "drive", turns: 512, until: 700_000_000 })).reason,
  "artifact_pending",
);
assert.equal((await host.handle({ kind: "save" })).reason, "artifact_pending");
assert.equal(
  (await host.handle({ kind: "artifact", acknowledged: "0".repeat(64) }))
    .reason,
  "artifact_acknowledgement_differs",
);
assert.deepEqual(
  await host.handle({ kind: "state" }),
  before,
  "Rejected requests cannot advance the world",
);
assert.deepEqual(
  await host.handle({ kind: "artifact", acknowledged: null }),
  offered,
  "A failed write can retry the identical bytes",
);
writeFileSync(join(output, offered.artifact.digest), offered.artifact.content);
assert.equal(
  readFileSync(join(output, offered.artifact.digest), "utf8"),
  offered.artifact.content,
);
assert.deepEqual(
  await host.handle({
    kind: "artifact",
    acknowledged: offered.artifact.digest,
  }),
  { kind: "artifact", artifact: null },
);
assert.deepEqual(
  await host.handle({
    kind: "artifact",
    acknowledged: offered.artifact.digest,
  }),
  { kind: "artifact", artifact: null },
);
assert.equal(
  (await host.handle({ kind: "drive", turns: 1, until: 700_000_000 })).kind,
  "drove",
);
await host.handle({ kind: "dispose" });
writeFileSync(
  join(output, "fixture.json"),
  JSON.stringify(
    { source, bundleDirectory: built.directory, manifest: built.manifest },
    null,
    2,
  ),
);
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    {
      result: "passed",
      protocolVersion: E.HOST_PROTOCOL_VERSION,
      bundle: built.manifest.bundle.id,
      backpressure: true,
      unchangedWorldWhilePending: true,
      retrySameBytes: true,
      repeatedAcknowledgement: true,
      pendingBytes: offered.artifact.byteLength,
    },
    null,
    2,
  ),
);
console.log(`Artifact handoff passed: ${output}`);
