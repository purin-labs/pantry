// Compare complete real journeys with different advance allowances. Ignore only
// host identities and command receipts; preserve every domain event and solver sample.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readRecordingPack } from "../../packages/production-simulation/src/recording-pack.ts";

assert.equal(
  process.argv.length,
  5,
  "Provide reference snapshot, candidate snapshot and report path.",
);
const reference = await inspect(process.argv[2]);
const candidate = await inspect(process.argv[3]);
assert.deepEqual(
  candidate.history,
  reference.history,
  "Every domain event keeps its time and content.",
);
assert.deepEqual(
  candidate.world,
  reference.world,
  "Logical and physical final states agree exactly.",
);
assert.deepEqual(
  candidate.observations,
  reference.observations,
  "Every exact pose and contact is preserved.",
);
await writeFile(
  process.argv[4],
  `${JSON.stringify(
    {
      result: "passed",
      reference: process.argv[2],
      candidate: process.argv[3],
      events: reference.history.length,
      observations: reference.observations,
      referenceRecordingBytes: reference.bytes,
      candidateRecordingBytes: candidate.bytes,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Exact journey and recording equivalence passed: ${process.argv[4]}`,
);

async function inspect(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  const {
    identity: _identity,
    commands: _commands,
    events,
    position,
    ...state
  } = document.state;
  const history = [];
  for (const { sequence: _sequence, execution: _execution, ...event } of events)
    if (event.kind !== "command-admitted") history.push(event);
  const operations = new Map();
  const idle = createHash("sha256");
  let idleRecords = 0;
  let bytes = 0;
  for (const entry of document.artifacts) {
    if (entry.role !== "recording-segment") continue;
    const content = await readFile(
      join(dirname(dirname(path)), "artifacts", entry.digest),
      "utf8",
    );
    assert.equal(Buffer.byteLength(content), entry.byteLength);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      entry.digest,
    );
    bytes += entry.byteLength;
    const decoded = readRecordingPack(content);
    assert.ok(decoded.ok);
    for (const record of decoded.value.records) {
      const text = decoded.value.body.slice(
        record.offset,
        record.offset + record.byteLength,
      );
      assert.equal(
        createHash("sha256").update(text).digest("hex"),
        record.digest,
      );
      const raw = JSON.parse(text);
      if (raw.kind === "accepted-cell-recording") {
        idle.update(raw.native);
        idleRecords += 1;
        continue;
      }
      let operation = operations.get(raw.attemptId);
      if (operation === undefined) {
        operation = {
          samples: createHash("sha256"),
          contacts: createHash("sha256"),
          sampleCount: 0,
          contactCount: 0,
          last: null,
        };
        operations.set(raw.attemptId, operation);
      }
      for (const sample of raw.samples) {
        const serialized = JSON.stringify(sample);
        if (sample.step === operation.sampleCount - 1) {
          assert.equal(
            serialized,
            operation.last,
            "Shared segment endpoints are identical.",
          );
          continue;
        }
        assert.equal(
          sample.step,
          operation.sampleCount,
          "No solver pose is omitted.",
        );
        operation.samples.update(serialized);
        operation.sampleCount += 1;
        operation.last = serialized;
      }
      assert.equal(raw.contacts.kind, "dense");
      for (const observation of raw.contacts.observations) {
        assert.equal(
          observation.step,
          operation.contactCount + 1,
          "No contact observation is omitted.",
        );
        operation.contacts.update(JSON.stringify(observation));
        operation.contactCount += 1;
      }
    }
  }
  const observed = [];
  for (const [attempt, operation] of operations)
    observed.push({
      attempt,
      sampleCount: operation.sampleCount,
      contactCount: operation.contactCount,
      samples: operation.samples.digest("hex"),
      contacts: operation.contacts.digest("hex"),
    });
  observed.sort(byAttempt);
  return {
    history,
    world: { ...state, time: position.time },
    bytes,
    observations: {
      operations: observed,
      idleRecords,
      idle: idle.digest("hex"),
    },
  };
}
function byAttempt(left, right) {
  return left.attempt.localeCompare(right.attempt);
}
