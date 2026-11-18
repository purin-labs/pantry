// A fingerprint of physics content: build identities, run ids and digests
// differ between builds and runs, and samples, contacts, events and outcomes
// must not. Two builds with equal fingerprints produced the same physics.
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/std/src/index.ts";

const IDENTITY_KEYS = new Set([
  "runnerSha256",
  "runtimeSha256",
  "controllerHash",
  "controllerSourceHash",
  "runtimeHash",
  "execution",
  "executionId",
  "hostSession",
  "bundle",
  "digest",
  "checkpoint",
  "predecessor",
  "runId",
  "byteLength",
  "content",
  "sha256",
  "binding",
  // A workflow revision is the digest of its definition, which names the cells.
  "revision",
  // An operation's margins against the robot's rated limits (Refactor 16,
  // step 7) measure the motion; they are not the motion. A build that adds
  // or changes a measurement keeps the fingerprint of an unchanged motion.
  // The journeys assert the margins on their own.
  "margins",
]);

// A SHA-256 names content, not motion. A model hash includes the hash of the
// asset list, so an entry for an unchanged model changes it (Refactor 16,
// step 9A); the digests of operation parameters include the model hash.
const DIGEST = /^[0-9a-f]{64}$/u;

/** The value without the keys that name a build, a run or a digest, and without digests. */
export function physics(value) {
  if (Array.isArray(value)) return value.map(physics);
  if (typeof value === "string" && DIGEST.test(value)) return "sha256";
  if (value === null || typeof value !== "object") return value;
  const kept = {};
  for (const [key, entry] of Object.entries(value))
    if (!IDENTITY_KEYS.has(key)) kept[key] = physics(entry);
  return kept;
}

export class Fingerprint {
  #hash = createHash("sha256");
  samples = 0;
  add(value) {
    this.#hash.update(canonicalJson(physics(value)));
    this.#hash.update("\n");
  }
  count(count) {
    this.samples += count;
  }
  digest() {
    return this.#hash.digest("hex");
  }
}

/**
 * The recorded physics of a run, apart from how it was cut into recordings:
 * each sample, contact observation and event, keyed by its cell or attempt,
 * its kind and its step. Two runs with equal results here recorded the same
 * physics, even when one advanced in larger calls. `contents` are the
 * decoded records of the run's recording packs. A step that two recordings
 * share must carry the same values in both; `conflicts` counts the others.
 */
export function recordedPhysics(contents) {
  const entries = new Map();
  let conflicts = 0;
  function put(key, value) {
    const text = canonicalJson(physics(value));
    const earlier = entries.get(key);
    if (earlier !== undefined && earlier !== text) conflicts += 1;
    entries.set(key, text);
  }
  function stepped(owner, kind, values) {
    for (const value of values ?? [])
      put(`${owner}|${kind}|${value.step}`, value);
  }
  for (const content of contents) {
    const record = JSON.parse(content);
    if (record.kind === "accepted-cell-recording") {
      const native = JSON.parse(record.native);
      const motion = native.motion;
      const owner = `cell:${record.cellId}`;
      if (motion.kind === "idle") {
        stepped(owner, "sample", motion.samples);
        stepped(owner, "contacts", motion.contacts?.observations);
      } else
        put(`${owner}|${motion.kind}|${motion.step}`, {
          before: motion.before,
          after: motion.after,
          beforeSlot: motion.beforeSlot,
          afterSlot: motion.afterSlot,
        });
      continue;
    }
    const owner = `attempt:${record.attemptId}`;
    stepped(owner, "sample", record.samples);
    stepped(owner, "contacts", record.contacts?.observations);
    for (const event of record.events ?? [])
      put(`${owner}|event|${event.step}|${event.kind}`, event);
  }
  const hash = createHash("sha256");
  for (const key of [...entries.keys()].sort()) {
    hash.update(key);
    hash.update("\t");
    hash.update(entries.get(key));
    hash.update("\n");
  }
  return { entries: entries.size, conflicts, digest: hash.digest("hex") };
}
