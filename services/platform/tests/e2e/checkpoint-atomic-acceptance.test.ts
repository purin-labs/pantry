import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi, type TestContext } from "vitest";
import {
  SqliteObservation,
  type SqliteObservationSnapshot,
} from "./sqlite-observation";
import { ORGANISATION_ID } from "./slack-journey-support";
import {
  chat,
  preparePortalChatJourney,
  readWork,
} from "./chat-journey-support";
import {
  FakeChatGpt,
  textAnswer,
  type ChatGptAnswer,
} from "./chatgpt-subscription-support";

it.for(["unobserved", "observed"] as const)(
  "rolls back rejected checkpoint acceptance and finalizes from saved records despite a stale response (%s)",
  { timeout: 60_000 },
  checkpointAcceptance,
);

async function checkpointAcceptance(
  measurement: "unobserved" | "observed",
  context: TestContext,
): Promise<void> {
  const chatgpt = new FakeChatGpt();
  const { session } = await preparePortalChatJourney({ chatgpt });
  const turns: (() => Promise<void>)[] = [];
  chatgpt.answer = answerTurn.bind(null, turns);
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  const evidence: Evidence = {
    rejected: false,
    rollbackVerified: false,
    alarmDeferred: false,
    sql: { kind: measurement },
  };
  // The fault is armed while the second turn's model request runs, before
  // the Session commits that turn's checkpoint.
  turns.push(armCheckpointFailure.bind(null, evidence));
  expect((await chat(session, 2)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  expect(evidence).toMatchObject({
    rejected: true,
    rollbackVerified: true,
    alarmDeferred: true,
  });
  expect(chatgpt.modelRequestCount()).toBe(2);
  expect(evidence.sql.kind).toBe(
    measurement === "observed" ? "recorded" : "unobserved",
  );
  Object.assign(context.task.meta, {
    checkpointAcceptance: {
      ...evidence,
      modelTurns: chatgpt.modelRequestCount(),
    },
  });
}

async function answerTurn(
  turns: (() => Promise<void>)[],
  _request: unknown,
  index: number,
): Promise<ChatGptAnswer> {
  await turns.shift()?.();
  return textAnswer(
    JSON.stringify({ kind: "reply", text: `TURN_${String(index + 1)}_OK` }),
  );
}

type Evidence = {
  rejected: boolean;
  rollbackVerified: boolean;
  alarmDeferred: boolean;
  sql:
    | { kind: "unobserved" | "observed" }
    | {
        kind: "recorded";
        rejected: SqliteObservationSnapshot;
        accepted: SqliteObservationSnapshot;
        partialRead: SqliteObservationSnapshot;
        consumedRead: SqliteObservationSnapshot;
        failedRead: SqliteObservationSnapshot;
      };
};

async function armCheckpointFailure(evidence: Evidence): Promise<void> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing session");
  await runInDurableObject(
    env.SESSION.getByName(row.name),
    injectTransitionFailure.bind(null, evidence),
  );
}

function injectTransitionFailure(
  evidence: Evidence,
  actor: object,
  state: DurableObjectState,
): void {
  const original = Reflect.get(actor, "commitCanonicalHarnessCheckpoint");
  if (typeof original !== "function")
    throw new Error("Missing checkpoint acceptance");
  Object.defineProperty(actor, "commitCanonicalHarnessCheckpoint", {
    configurable: true,
    value: rejectThenAccept.bind(null, evidence, actor, state, original),
  });
}

async function rejectThenAccept(
  evidence: Evidence,
  actor: object,
  state: DurableObjectState,
  original: Function,
  checkpoint: unknown,
  transition: unknown,
): Promise<unknown> {
  if (evidence.sql.kind === "unobserved")
    return acceptAfterRejection(
      evidence,
      actor,
      state,
      original,
      checkpoint,
      transition,
      null,
    );
  const observation = new SqliteObservation(
    state.storage.sql.exec.bind(state.storage.sql),
    state.storage.sql,
  );
  const spy = vi
    .spyOn(state.storage.sql, "exec")
    .mockImplementation(observation.exec.bind(observation));
  try {
    return await acceptAfterRejection(
      evidence,
      actor,
      state,
      original,
      checkpoint,
      transition,
      observation,
    );
  } finally {
    spy.mockRestore();
  }
}

async function acceptAfterRejection(
  evidence: Evidence,
  actor: object,
  state: DurableObjectState,
  original: Function,
  checkpoint: unknown,
  transition: unknown,
  observation: SqliteObservation | null,
): Promise<unknown> {
  const before = checkpointRows(state);
  const invalid = JSON.parse(JSON.stringify(transition));
  invalid.event.sequence += 1;
  const rejected = await Reflect.apply(original, actor, [checkpoint, invalid]);
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "journal_sequence_gap" },
  });
  evidence.rejected = true;
  const rejectedUsage = observation?.snapshot() ?? null;
  expect(checkpointRows(state)).toEqual(before);
  evidence.rollbackVerified = true;
  Object.defineProperty(actor, "commitCanonicalHarnessCheckpoint", {
    configurable: true,
    value: original,
  });
  const accepted = await Reflect.apply(original, actor, [
    checkpoint,
    transition,
  ]);
  expect(accepted).toMatchObject({ ok: true });
  const alarm = Reflect.get(actor, "alarm");
  if (typeof alarm !== "function") throw new Error("Missing alarm");
  await Reflect.apply(alarm, actor, []);
  const lifecycle = state.storage.sql
    .exec("SELECT lifecycle_kind FROM session_meta")
    .one();
  expect(lifecycle.lifecycle_kind).toBe("checkpointing");
  evidence.alarmDeferred = true;
  if (observation !== null && rejectedUsage !== null) {
    const acceptedUsage = observation.snapshot();
    const cursor = state.storage.sql.exec(
      "SELECT sequence FROM actor_journal ORDER BY sequence",
    );
    const first = cursor.raw().next();
    expect(first.done).toBe(false);
    const beforeSample = cursor.rowsRead;
    const partialRead = observation.snapshot();
    expect(cursor.rowsRead).toBe(beforeSample);
    const remaining = cursor.toArray();
    expect(remaining.length).toBeGreaterThan(1);
    const consumedRead = observation.snapshot();
    expect(consumedRead.rowsRead).toBeGreaterThan(partialRead.rowsRead);
    expect(consumedRead.rowsRead).toBeGreaterThan(consumedRead.initialRowsRead);
    expect(consumedRead.kind).toBe("observed_at_boundary");
    // A failed native call has no cursor. Its resource cost must remain unknown.
    expect(
      state.storage.sql.exec.bind(
        state.storage.sql,
        "SELECT * FROM plan55_missing_table",
      ),
    ).toThrow();
    const failedRead = observation.snapshot();
    expect(failedRead.kind).toBe("incomplete");
    expect(failedRead.failedCalls).toBe(1);
    evidence.sql = {
      kind: "recorded",
      rejected: rejectedUsage,
      accepted: acceptedUsage,
      partialRead,
      consumedRead,
      failedRead,
    };
  }
  // The saved record is authoritative when the caller's response is stale.
  const staleResponse = JSON.parse(JSON.stringify(accepted));
  staleResponse.value.checkpoint.cursor.lastSequence = 0;
  return staleResponse;
}

function checkpointRows(state: DurableObjectState): unknown {
  return state.storage.sql
    .exec("SELECT * FROM session_harness_checkpoint ORDER BY session_id")
    .toArray();
}
