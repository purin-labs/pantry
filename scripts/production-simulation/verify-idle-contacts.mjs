// Real idle MuJoCo evolution, including admission, settling and a fresh host.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { wasmTransport } from "../../packages/production-simulation/src/native/wasm-transport.ts";
import { readOperationContacts } from "../../packages/production-simulation/src/physics-contacts.ts";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory.");
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const runtime = resolve(
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
const definition = await prepareCell(runtime, "idle-contact-cell");
await save("definition.json", definition);
const reference = await capture(1, false);
const bounded = await capture(32, false);
const restored = await capture(32, true);
assert.deepEqual(bounded.samples, reference.samples);
assert.deepEqual(bounded.contacts, reference.contacts);
assert.deepEqual(restored.samples, reference.samples);
assert.deepEqual(restored.contacts, reference.contacts);
assert.deepEqual(bounded.checkpoint, reference.checkpoint);
assert.deepEqual(restored.checkpoint, reference.checkpoint);
assert.ok(
  reference.contacts.some(hasSupport),
  "The admitted tray must produce real table contacts.",
);
assert.equal(reference.samples.length, 2049);
assert.equal(reference.contacts.length, 2048);
await save("reference.json", reference);
await save("bounded.json", bounded);
await save("restored.json", restored);
await save("report.json", {
  result: "passed",
  runtime: BAKERY_BROWSER_BUNDLE.id,
  simulatedSeconds: 4.096,
  samples: reference.samples.length,
  contactObservations: reference.contacts.length,
  exactBoundedPosesAndContacts: true,
  exactFreshHostPosesAndContacts: true,
  exactFinalCheckpoint: true,
});
console.log(`Idle contact continuity passed: ${output}`);

async function openHost(opening) {
  const module = await runtimeModule(runtime);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const host = wasmTransport(module, {
    encode: encoder.encode.bind(encoder),
    decode: decoder.decode.bind(decoder),
  });
  await send(host, { op: "open", cell: definition.cellId, opening }, "opened");
  return host;
}
async function send(host, command, kind) {
  const reply = await host.send(command);
  assert.equal(reply.kind, kind, JSON.stringify(reply));
  return reply;
}
async function capture(allowance, interrupt) {
  let host = await openHost({ kind: "create", definition });
  const cell = definition.cellId;
  await send(
    host,
    {
      op: "prepare",
      cell,
      boundary: "admit",
      change: { kind: "admission", carrier: "tray-a" },
    },
    "prepared",
  );
  await send(host, { op: "commit", cell, boundary: "admit" }, "committed");
  const samples = [];
  const contacts = [];
  let step = 0;
  while (step < 2048) {
    const reply = await send(
      host,
      { op: "advance", cell, steps: allowance },
      "advanced",
    );
    assert.equal(reply.stop, "idle");
    const motion = reply.recording.motion;
    assert.equal(motion.sampleStride, 1);
    assert.equal(motion.startStep, step);
    assert.equal(motion.endStep, step + allowance);
    assert.equal(motion.samples.length, allowance + 1);
    if (samples.length === 0) samples.push(motion.samples[0]);
    else assert.deepEqual(samples.at(-1), motion.samples[0]);
    samples.push(...motion.samples.slice(1));
    const evidence = readOperationContacts(
      motion.contacts,
      motion.startStep,
      motion.endStep,
    );
    assert.equal(evidence.kind, "dense");
    contacts.push(...evidence.observations);
    step = motion.endStep;
    if (interrupt && step === 1024) {
      const exported = await send(host, { op: "export", cell }, "exported");
      await send(host, { op: "dispose", cell }, "disposed");
      host = await openHost({
        kind: "restore",
        content: exported.content,
        digest: exported.checkpoint.digest,
        sequence: 0,
      });
    }
  }
  const exported = await send(host, { op: "export", cell }, "exported");
  await send(host, { op: "dispose", cell }, "disposed");
  return { samples, contacts, checkpoint: JSON.parse(exported.content) };
}
function hasSupport(observation) {
  for (const pair of observation.pairs)
    if (
      pair.first.geometry === "table_top" ||
      pair.second.geometry === "table_top"
    )
      return true;
  return false;
}
async function save(file, value) {
  await writeFile(join(output, file), `${JSON.stringify(value)}\n`);
}
