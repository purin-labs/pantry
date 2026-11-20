import { sessionModule } from "./session-module-support";
import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { ORGANISATION_ID } from "./slack-journey-support";
import {
  chat,
  preparePortalChatJourney,
  readWork,
  answerTurn,
} from "./chat-journey-support";
import { FakeChatGpt } from "./chatgpt-subscription-support";

it(
  "rolls back rejected checkpoint acceptance and finalizes from saved records despite a stale response",
  { timeout: 60_000 },
  checkpointAcceptance,
);

async function checkpointAcceptance(context: TestContext): Promise<void> {
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
  Object.assign(context.task.meta, {
    checkpointAcceptance: {
      ...evidence,
      modelTurns: chatgpt.modelRequestCount(),
    },
  });
}

type Evidence = {
  rejected: boolean;
  rollbackVerified: boolean;
  alarmDeferred: boolean;
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
  // The harness turns module of the Session accepts the checkpoint.
  const turns = sessionModule(actor, "harnessTurns");
  const original = Reflect.get(turns, "commitCanonicalHarnessCheckpoint");
  if (typeof original !== "function")
    throw new Error("Missing checkpoint acceptance");
  Object.defineProperty(turns, "commitCanonicalHarnessCheckpoint", {
    configurable: true,
    value: acceptAfterRejection.bind(null, evidence, actor, state, original),
  });
}

async function acceptAfterRejection(
  evidence: Evidence,
  actor: object,
  state: DurableObjectState,
  original: Function,
  checkpoint: unknown,
  transition: unknown,
): Promise<unknown> {
  const turns = sessionModule(actor, "harnessTurns");
  const before = checkpointRows(state);
  const invalid = JSON.parse(JSON.stringify(transition));
  invalid.event.sequence += 1;
  const rejected = await Reflect.apply(original, turns, [checkpoint, invalid]);
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "journal_sequence_gap" },
  });
  evidence.rejected = true;
  expect(checkpointRows(state)).toEqual(before);
  evidence.rollbackVerified = true;
  Object.defineProperty(turns, "commitCanonicalHarnessCheckpoint", {
    configurable: true,
    value: original,
  });
  const accepted = await Reflect.apply(original, turns, [
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
