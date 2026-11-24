import { sessionModule } from "./session-module-support";
import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi, type TestContext } from "vitest";
import {
  BindingObservation,
  type BindingObservationSnapshot,
} from "./binding-observation";
import {
  SqliteObservation,
  type SqliteObservationSnapshot,
} from "./sqlite-observation";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { SessionDO } from "../../src/actors/agent-session";
import { preflightHarnessTurnLeaseInTransaction } from "@purin-labs/agent/actors/agent-session-harness-authority";
import { closeActorExecutionAdmission } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { readActivationExportSource } from "@purin-labs/actor-runtime/actors/actor-export";
import { ORGANISATION_ID } from "./slack-journey-support";
import {
  chat,
  goalCommand,
  preparePortalChatJourney,
  readWork,
  answerTurn,
} from "./chat-journey-support";
import { FakeChatGpt } from "./chatgpt-subscription-support";
import { runArmedAlarm } from "./durable-object-alarm-support";

type RestartTrial = {
  readonly admission: "open" | "closing";
  readonly boundary: "before_upload" | "after_upload";
  readonly checkpointSize: "ordinary" | "large";
};

const recoveryObservations = new WeakMap<
  DurableObjectState,
  {
    readonly observation: SqliteObservation;
    readonly bindings: BindingObservation;
    readonly envDescriptor: PropertyDescriptor;
    readonly restore: () => void;
  }
>();

it.for([
  {
    admission: "closing",
    boundary: "before_upload",
    checkpointSize: "ordinary",
  },
  { admission: "open", boundary: "before_upload", checkpointSize: "large" },
  { admission: "open", boundary: "after_upload", checkpointSize: "large" },
  {
    admission: "closing",
    boundary: "after_upload",
    checkpointSize: "ordinary",
  },
] as const)(
  "recovers a saved checkpoint after $boundary loss under $admission admission without repeating inference",
  { timeout: 60_000 },
  restartFinalization,
);

type Fault = {
  readonly boundary: RestartTrial["boundary"];
  readonly checkpointSize: RestartTrial["checkpointSize"];
  state:
    | { kind: "waiting" }
    | { kind: "saved"; name: string; lease: HarnessTurnLease }
    | {
        kind: "crashed";
        name: string;
        lease: HarnessTurnLease;
        object: { key: string; size: number } | null;
      };
};

async function restartFinalization(
  trial: RestartTrial,
  context: TestContext,
): Promise<void> {
  const { admission, boundary, checkpointSize } = trial;
  const chatgpt = new FakeChatGpt();
  const { session } = await preparePortalChatJourney({ chatgpt });
  const turns: (() => Promise<void>)[] = [];
  chatgpt.answer = answerTurn.bind(null, turns);
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  expect(
    (
      await goalCommand(session, 0, {
        kind: "set",
        objective: "Finish the stock review after a restart",
        tokenBudget: 1,
      })
    ).status,
  ).toBe(200);
  const fault: Fault = { boundary, checkpointSize, state: { kind: "waiting" } };
  // The crash is armed while the second turn's model request runs, before
  // the Session commits that turn's checkpoint.
  turns.push(armCrash.bind(null, fault));
  expect((await chat(session, 2)).status).toBe(200);
  await expect
    .poll(crashAccepted.bind(null, fault), { timeout: 15_000 })
    .toBe(true);
  if (fault.state.kind !== "crashed") throw new Error("Missing crashed Actor");
  const crashObject = fault.state.object;
  expect(crashObject === null).toBe(boundary === "before_upload");
  const actor = env.SESSION.getByName(fault.state.name);
  const { before, staleLease } = await runInDurableObject(
    actor,
    prepareRecovery.bind(null, admission, boundary, fault.state.lease),
  );
  // The turn completes before the archive write. A loss before the write
  // leaves the turn open, and a loss after it leaves a completed turn.
  expect(before).toMatchObject(
    boundary === "before_upload"
      ? { lifecycle: "checkpointing", stream: "running" }
      : { lifecycle: "sleeping", stream: "complete" },
  );
  expect(before).toMatchObject({ leases: 0, reservations: 0 });
  expect(before.publication).toBe("upload_pending");
  expect(before.payloadChunks > 1).toBe(checkpointSize === "large");
  expect(staleLease).toEqual({
    ok: false,
    error: { code: "harness_lease_missing" },
  });
  await runInDurableObject(actor, observeRecoveryResources);
  let usage: {
    sql: SqliteObservationSnapshot;
    bindings: BindingObservationSnapshot;
  };
  try {
    await runArmedAlarm(actor);
  } finally {
    usage = await runInDurableObject(actor, finishRecoveryObservation);
  }
  const sqlUsage = usage.sql;
  expect(sqlUsage.kind).toBe("observed_at_boundary");
  const sizes = sqlUsage.databaseSize;
  if (sizes.initial.kind !== "available" || sizes.current.kind !== "available")
    throw new Error("Missing native SQLite size");
  expect(sizes.initial.bytes).toBeGreaterThan(0);
  expect(sizes.current.bytes).toBeGreaterThan(0);
  if (checkpointSize === "large")
    expect(sizes.initial.bytes).toBeGreaterThan(3 * 1024 * 1024);
  expect(sqlUsage.calls).toBeGreaterThan(0);
  expect(usage.bindings.kind).toBe("settled_calls");
  // An admission that closes before the turn completes stops the recovery
  // before it reads the archive.
  if (admission === "closing" && boundary === "before_upload") {
    expect(usage.bindings.operations).toEqual({});
  } else {
    expect(usage.bindings.operations["r2.head"]?.fulfilled).toBe(1);
    if (boundary === "after_upload") {
      if (crashObject === null) throw new Error("Missing uploaded checkpoint");
      expect(usage.bindings.operations["r2.put"]).toBeUndefined();
      expect(usage.bindings.operations["r2.head"]).toMatchObject({
        knownObjectResults: 1,
        knownObjectBytes: crashObject.size,
        nullObjectResults: 0,
        unknownObjectSizeResults: 0,
      });
    } else {
      expect(usage.bindings.operations["r2.put"]?.fulfilled).toBe(1);
      expect(usage.bindings.operations["r2.head"]?.nullObjectResults).toBe(1);
      const uploaded = usage.bindings.operations["r2.put"];
      expect(uploaded?.knownObjectResults).toBe(1);
      expect(uploaded?.unknownObjectSizeResults).toBe(0);
      expect(uploaded?.knownObjectBytes).toBeGreaterThan(
        checkpointSize === "large" ? 3 * 1024 * 1024 : 0,
      );
    }
  }
  const after = await runInDurableObject(actor, inspectFinalization);
  if (admission === "open") {
    expect(after).toMatchObject({
      lifecycle: "sleeping",
      leases: 0,
      reservations: 0,
      stream: "complete",
    });
    await expect
      .poll(readWork.bind(null, session), { timeout: 15_000 })
      .toBe("ready");
  } else {
    // Nothing is completed and nothing is marked as published while the
    // admission is closed. The payload stays in the Session.
    expect(after).toEqual(before);
  }
  if (admission === "open") {
    // The recovered Session keeps the payload: its next turn restores from it.
    expect(after.publication).toBe("published");
    expect(after.payloadChunks).toBe(before.payloadChunks);
  }
  expect(after.tokens).toBe(before.tokens);
  expect(after.checkpointSequence).toBe(before.checkpointSequence);
  expect(after.outputSequence).toBe(before.outputSequence);
  expect(after.historySequence).toBe(before.historySequence);
  expect(chatgpt.modelRequestCount()).toBe(2);
  const ownerRow = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS id, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
    )
    .bind(ORGANISATION_ID)
    .first<{ id: string; name: string }>();
  if (ownerRow === null) throw new Error("Missing goal owner");
  const goal = await env.CASE.getByName(ownerRow.name).readGoal({
    organisationId: ORGANISATION_ID,
    caseId: ownerRow.id,
  });
  expect(goal).toMatchObject({
    ok: true,
    value: {
      goal: {
        tokensUsed: 12,
        unknownOperations: 0,
        state: { kind: "budget_limited" },
      },
    },
  });
  const rangeRead =
    crashObject === null ? null : await readCheckpointRange(crashObject);
  Object.assign(context.task.meta, {
    checkpointRestart: {
      admission,
      boundary,
      checkpointSize,
      crashObject,
      before,
      after,
      staleLease,
      goal,
      modelTurns: chatgpt.modelRequestCount(),
      sqlUsage,
      bindingUsage: usage.bindings,
      rangeRead,
    },
  });
}

async function readCheckpointRange(object: { key: string; size: number }) {
  const observation = new BindingObservation();
  const bucket = observation.r2(env.ARCHIVE);
  const result = await bucket.get(object.key, {
    range: { offset: 0, length: 16 },
  });
  if (result === null || !("body" in result))
    throw new Error("Missing published checkpoint body");
  expect(result.bodyUsed).toBe(false);
  const body = await result.arrayBuffer();
  expect(body.byteLength).toBe(16);
  const usage = observation.snapshot();
  expect(usage.kind).toBe("settled_calls");
  expect(usage.operations["r2.get"]).toMatchObject({
    knownObjectResults: 1,
    knownObjectBytes: object.size,
    nullObjectResults: 0,
    unknownObjectSizeResults: 0,
  });
  return { bodyBytes: body.byteLength, objectBytes: object.size, usage };
}

function observeRecoveryResources(
  actor: object,
  state: DurableObjectState,
): void {
  const envDescriptor = Object.getOwnPropertyDescriptor(actor, "env");
  if (envDescriptor === undefined) throw new Error("Missing Actor environment");
  const originalEnv = Reflect.get(actor, "env");
  const bindings = new BindingObservation();
  const observedEnv = Object.create(originalEnv);
  Object.defineProperty(observedEnv, "ARCHIVE", {
    value: bindings.r2(Reflect.get(originalEnv, "ARCHIVE")),
  });
  Object.defineProperty(actor, "env", { ...envDescriptor, value: observedEnv });
  const observation = new SqliteObservation(
    state.storage.sql.exec.bind(state.storage.sql),
    state.storage.sql,
  );
  const spy = vi
    .spyOn(state.storage.sql, "exec")
    .mockImplementation(observation.exec.bind(observation));
  recoveryObservations.set(state, {
    observation,
    bindings,
    envDescriptor,
    restore: spy.mockRestore.bind(spy),
  });
}

function finishRecoveryObservation(actor: object, state: DurableObjectState) {
  const active = recoveryObservations.get(state);
  if (active === undefined) throw new Error("Missing recovery observation");
  active.restore();
  Object.defineProperty(actor, "env", active.envDescriptor);
  recoveryObservations.delete(state);
  return {
    sql: active.observation.snapshot(),
    bindings: active.bindings.snapshot(),
  };
}

function crashAccepted(fault: Fault): boolean {
  return fault.state.kind === "crashed";
}

async function armCrash(fault: Fault): Promise<void> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing session");
  await runInDurableObject(
    env.SESSION.getByName(row.name),
    injectCrash.bind(null, fault, row.name),
  );
}

function injectCrash(
  fault: Fault,
  name: string,
  actor: object,
  state: DurableObjectState,
): void {
  // The harness turns module of the Session accepts the checkpoint.
  const turns = sessionModule(actor, "harnessTurns");
  const original = Reflect.get(turns, "commitCanonicalHarnessCheckpoint");
  if (typeof original !== "function")
    throw new Error("Missing checkpoint acceptance");
  Object.defineProperty(turns, "commitCanonicalHarnessCheckpoint", {
    configurable: true,
    value: crashAfterCommit.bind(null, fault, name, turns, state, original),
  });
  if (fault.boundary === "after_upload") {
    const actorEnv = Object.create(Reflect.get(actor, "env"));
    Object.defineProperty(actorEnv, "ARCHIVE", {
      value: new Proxy(env.ARCHIVE, {
        get: archiveProperty.bind(null, fault, state),
      }),
    });
    Object.defineProperty(actor, "env", {
      value: actorEnv,
      configurable: true,
    });
  }
}

async function crashAfterCommit(
  fault: Fault,
  name: string,
  actor: object,
  state: DurableObjectState,
  original: Function,
  checkpoint: Parameters<SessionDO["commitCanonicalHarnessCheckpoint"]>[0],
  transition: Parameters<SessionDO["commitCanonicalHarnessCheckpoint"]>[1],
): Promise<unknown> {
  if (fault.checkpointSize === "large")
    checkpoint.checkpoint = largeCheckpoint(checkpoint.checkpoint);
  const result: Awaited<
    ReturnType<SessionDO["commitCanonicalHarnessCheckpoint"]>
  > = await Reflect.apply(original, actor, [checkpoint, transition]);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.code);
  await state.storage.sync();
  if (fault.boundary === "after_upload") {
    fault.state = { kind: "saved", name, lease: transition.harnessLease };
    return result;
  }
  expect(
    await env.ARCHIVE.head(result.value.checkpoint.blob.objectKey),
  ).toBeNull();
  fault.state = {
    kind: "crashed",
    name,
    lease: transition.harnessLease,
    object: null,
  };
  return state.abort("Checkpoint upload interrupted before R2");
}

function archiveProperty(
  fault: Fault,
  state: DurableObjectState,
  target: R2Bucket,
  key: string | symbol,
): unknown {
  const value = Reflect.get(target, key, target);
  if (key === "put" && typeof value === "function")
    return crashAfterUpload.bind(null, fault, state, target, value);
  return typeof value === "function" ? value.bind(target) : value;
}

async function crashAfterUpload(
  fault: Fault,
  state: DurableObjectState,
  bucket: R2Bucket,
  original: Function,
  ...args: Parameters<R2Bucket["put"]>
): Promise<unknown> {
  const written = await Reflect.apply(original, bucket, args);
  expect(written).not.toBeNull();
  const object = await bucket.head(args[0]);
  if (object === null) throw new Error("Missing uploaded object");
  if (fault.state.kind !== "saved") throw new Error("Missing saved completion");
  await state.storage.sync();
  fault.state = {
    kind: "crashed",
    name: fault.state.name,
    lease: fault.state.lease,
    object: { key: object.key, size: object.size },
  };
  return state.abort(
    "Checkpoint upload interrupted after R2 before publication",
  );
}

function prepareRecovery(
  admission: RestartTrial["admission"],
  boundary: RestartTrial["boundary"],
  lease: HarnessTurnLease,
  actor: object,
  state: DurableObjectState,
) {
  const before = inspectFinalization(actor, state);
  const staleLease = preflightHarnessTurnLeaseInTransaction(
    state.storage.sql,
    lease,
    Date.now(),
  );
  if (admission === "closing") {
    if (boundary === "before_upload")
      closeAdmissionDuringFinalization(actor, state);
    else closeAdmissionDuringPublication(actor, state);
  }
  return { before, staleLease };
}

/** Close the admission after the publication reads the archive. */
function closeAdmissionDuringPublication(
  actor: object,
  state: DurableObjectState,
): void {
  const actorEnv = Object.create(Reflect.get(actor, "env"));
  Object.defineProperty(actorEnv, "ARCHIVE", {
    value: new Proxy(env.ARCHIVE, {
      get: closingArchiveProperty.bind(null, actor, state),
    }),
  });
  Object.defineProperty(actor, "env", { value: actorEnv, configurable: true });
}

function closingArchiveProperty(
  actor: object,
  state: DurableObjectState,
  target: R2Bucket,
  key: string | symbol,
): unknown {
  const value = Reflect.get(target, key, target);
  if (key === "head" && typeof value === "function")
    return closeAdmissionAfterHead.bind(null, actor, state, target, value);
  return typeof value === "function" ? value.bind(target) : value;
}

async function closeAdmissionAfterHead(
  actor: object,
  state: DurableObjectState,
  bucket: R2Bucket,
  original: Function,
  ...args: Parameters<R2Bucket["head"]>
): Promise<unknown> {
  const found = await Reflect.apply(original, bucket, args);
  closeFinalizationAdmission(actor, state);
  return found;
}

function closeFinalizationAdmission(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const activation = readActivationExportSource(state.storage.sql);
  if (!activation.ok) throw new Error(activation.error.code);
  const closed = closeActorExecutionAdmission(
    state.storage.sql,
    activation.value.fenceToken,
  );
  if (!closed.ok) throw new Error(closed.error.code);
}

function closeAdmissionDuringFinalization(
  actor: object,
  state: DurableObjectState,
): void {
  // The checkpoints module of the Session finalizes; the hook is on it.
  const checkpoints = sessionModule(actor, "checkpoints");
  const original = Reflect.get(
    checkpoints,
    "completeCanonicalCheckpointAndStream",
  );
  if (typeof original !== "function") throw new Error("Missing finalizer");
  Object.defineProperty(checkpoints, "completeCanonicalCheckpointAndStream", {
    configurable: true,
    value: closeAdmissionBeforeCommit.bind(null, checkpoints, state, original),
  });
}

function closeAdmissionBeforeCommit(
  actor: object,
  state: DurableObjectState,
  original: Function,
  input: Parameters<SessionDO["completeCanonicalCheckpointAndStream"]>[0],
): unknown {
  closeFinalizationAdmission(actor, state);
  return Reflect.apply(original, actor, [input]);
}

function inspectFinalization(_actor: unknown, state: DurableObjectState) {
  const row = state.storage.sql
    .exec<{ lifecycle_kind: string }>("SELECT lifecycle_kind FROM session_meta")
    .one();
  const stream = state.storage.sql
    .exec<{ state: string; last_sequence: number }>(
      "SELECT state, last_sequence FROM session_turn_stream ORDER BY started_at DESC LIMIT 1",
    )
    .one();
  const budget = state.storage.sql
    .exec<{ usage_json: string }>(
      "SELECT usage_json FROM session_budget_account",
    )
    .one();
  return {
    lifecycle: row.lifecycle_kind,
    stream: stream.state,
    outputSequence: stream.last_sequence,
    checkpointSequence: state.storage.sql
      .exec<{ last_sequence: number }>(
        "SELECT last_sequence FROM session_harness_checkpoint ORDER BY committed_at DESC LIMIT 1",
      )
      .one().last_sequence,
    publication: state.storage.sql
      .exec<{ upload_state: string }>(
        "SELECT upload_state FROM session_harness_checkpoint ORDER BY committed_at DESC LIMIT 1",
      )
      .one().upload_state,
    payloadChunks: state.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM session_harness_checkpoint_payload",
      )
      .one().n,
    historySequence: state.storage.sql
      .exec<{ sequence: number }>(
        "SELECT max(sequence) AS sequence FROM session_harness_history",
      )
      .one().sequence,
    leases: state.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM session_harness_lease")
      .one().n,
    reservations: state.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM session_budget_reservation",
      )
      .one().n,
    tokens: JSON.parse(budget.usage_json).tokens,
  };
}

function largeCheckpoint(checkpoint: ArrayBuffer): ArrayBuffer {
  // Trailing JSON whitespace preserves the parsed harness state.
  const bytes = new Uint8Array(checkpoint.byteLength + 3 * 1024 * 1024).fill(
    32,
  );
  bytes.set(new Uint8Array(checkpoint));
  return bytes.buffer;
}
