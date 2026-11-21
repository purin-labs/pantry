import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  preparePortalObservation,
  canObservePortal,
  canOtherMemberObserve,
} from "./portal-observation-fixture.mjs";

const WRITES = 128;

export async function exerciseSlowWatch(root, harness, actor) {
  const observation = await preparePortalObservation(actor);
  if (!(await canObservePortal(observation)))
    throw new Error("Authorized Portal observer denied");
  if (await canOtherMemberObserve(observation))
    throw new Error("Private conversation visible to another member");
  const fastWatch = await root.watch(BACKGROUND_CONTEXT);
  const slowWatch = await root.watch(BACKGROUND_CONTEXT);
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const fast = observer(
    fastWatch.value,
    Promise.resolve(),
    entered,
    observation,
  );
  const slow = observer(slowWatch.value, release.promise, entered, observation);
  fastWatch.start(captureFrame.bind(null, fast));
  slowWatch.start(captureFrame.bind(null, slow));
  try {
    await writeProbe(root, 0);
    await entered.promise;
    await waitForFrame(fast, 1);
    for (let index = 1; index < WRITES; index += 1) {
      await writeProbe(root, index);
      await waitForFrame(fast, index + 1);
    }
    await fast.done.promise;
    release.resolve();
    await slow.done.promise;
    if (!(await canObservePortal(observation)))
      throw new Error("Reconnecting Portal observer denied");
    const reconnected = await root.watch(BACKGROUND_CONTEXT);
    try {
      const expected = canonicalJson(reconnected.value);
      if (
        !sameView(fast.value, reconnected.value) ||
        !sameView(slow.value, reconnected.value)
      )
        throw new Error(
          "Watch consumers did not reconstruct the reconnect snapshot",
        );
      // Pi 1.5 folds the frames a slow listener missed into its next call,
      // and replaces the value only when its queue overflows.
      if (slow.frames >= fast.frames)
        throw new Error("Slow watch did not fold its pending frames");
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      return {
        authorization: {
          allowed: true,
          otherMemberDenied: true,
        },
        passiveWrites: WRITES,
        fast: { frames: fast.frames, replacements: fast.replacements },
        slow: { frames: slow.frames, replacements: slow.replacements },
        snapshotDigest: await sha256Hex(expected),
        probeEntries: probeEntries(reconnected.value),
        inspection,
      };
    } finally {
      await reconnected.stop();
    }
  } finally {
    release.resolve();
    await fastWatch.stop();
    await slowWatch.stop();
  }
}

function observer(value, release, entered, observation) {
  return {
    value,
    release,
    entered,
    done: Promise.withResolvers(),
    frames: 0,
    replacements: 0,
    observation,
    delivered: Promise.withResolvers(),
  };
}

async function captureFrame(observer, { value, ops }) {
  try {
    if (!(await canObservePortal(observer.observation)))
      throw new Error("Portal observer lost access during the watch trial");
    observer.frames += 1;
    observer.value = applyImmutable(observer.value, ops);
    if (canonicalJson(observer.value) !== canonicalJson(value))
      throw new Error("Watch delta differs from its committed frame");
    if (ops.some(isReplacement)) observer.replacements += 1;
    observer.delivered.resolve();
    observer.delivered = Promise.withResolvers();
    if (observer.frames === 1) {
      observer.entered.resolve();
      await observer.release;
    }
    if (probeEntries(value) === WRITES) observer.done.resolve();
  } catch (error) {
    observer.done.reject(error);
    throw error;
  }
}

// A new watch starts with a shorter window of entries (Pi 1.5), so the
// reconnect snapshot's entries must be the newest entries a consumer holds.
// Pi 1.5 views can place a key elsewhere than the applied ops do, so values
// compare as canonical JSON.
function sameView(observed, snapshot) {
  const window = snapshot.entries.length;
  return (
    canonicalJson(viewState(observed)) === canonicalJson(viewState(snapshot)) &&
    canonicalJson(observed.entries.slice(-window)) ===
      canonicalJson(snapshot.entries)
  );
}

function viewState(view) {
  const { entries: _entries, before: _before, ...state } = view;
  return state;
}

function isReplacement(op) {
  return op[0] === "r";
}

async function waitForFrame(observer, writes) {
  while (probeEntries(observer.value) < writes)
    await Promise.race([observer.delivered.promise, observer.done.promise]);
}

// Pi appends a display-only write at once, so each probe is an entry of the
// conversation view, not an inbox item. The view holds only the newest
// entries (Pi 1.5), so the probes seen are counted by the newest index.
function probeEntries(view) {
  return view.entries
    .filter(isProbeEntry)
    .reduce((seen, entry) => Math.max(seen, entry.data.index + 1), 0);
}

function isProbeEntry(entry) {
  return entry.kind === "pantry.observation_probe";
}

function writeProbe(root, index) {
  return root.submit(
    {
      type: "write",
      requestId: `observation_probe_${index}`,
      entry: { kind: "pantry.observation_probe", data: { index } },
    },
    BACKGROUND_CONTEXT,
  );
}
