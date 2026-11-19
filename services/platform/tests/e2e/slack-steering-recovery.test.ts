import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { listPlacementActorRegistryEntries } from "../../src/actors/actor-registry";
import { connectorActorStub } from "../../src/actors/actor-router";
import {
  DISCOVER_INTEGRATION_LIST,
  countCalls,
  deliverAfterConnectorLease,
  endCaseWorkLease,
  makeCaseWorkDue,
  loseSession,
  readLifecycleKind,
  scriptReply,
  sendThreadMessage,
  startScriptTurn,
} from "./durable-codemode-journey-support";
import { readReceipt, readSteeredReplies } from "./slack-follow-up-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  threadAndText,
  userMessageContaining,
  userMessageIs,
} from "./slack-journey-support";

/**
 * A steering reply survives the loss of the Session Actor (Plan 71,
 * acceptance item 3).
 *
 * A person asks in Slack for a check that runs a Code Mode script of two
 * reads. While the second read is in flight, the same person replies in the
 * thread: the turn admits the reply, and Pi queues it for its next boundary.
 * The process of the Session then ends before the reply reaches the
 * transcript. The next process resumes the turn with a fresh lease. The
 * script finishes, and Pi places the reply after the script's result. The
 * thread gets one answer that follows the reply. The model reads the reply
 * one time, and the history of the turn holds it one time. The reply settles
 * as part of that turn, and the next turn of the thread reads it.
 */
it(
  "places a queued steering reply once after the Session Actor is lost",
  steeringRecoveryJourney,
  120_000,
);

const SCRIPT =
  "const first = JSON.parse(await tools.integration_list({})); const second = JSON.parse(await tools.integration_list({})); text({ reads: 2, accounts: [first.accounts.length, second.accounts.length] });";
const ROOT_EVENT = "Ev_STEER_LOSS_ROOT";
const REPLY_EVENT = "Ev_STEER_LOSS_REPLY";
const FOLLOW_EVENT = "Ev_STEER_LOSS_FOLLOW";
const REPLY_TS = "1787500000.000002";
const FOLLOW_TS = "1787500000.000003";
const REPLY_TEXT = "Only count the Dropbox accounts, please.";
const FOLLOW_TEXT = "Thanks. Note the count.";
const ANSWER = "STEERED_COUNT_REPORTED";
const NOTED = "COUNT_NOTED";

async function steeringRecoveryJourney(test: TestContext): Promise<void> {
  // The first read passes. The second read is in flight when the process
  // ends, and the next process holds its completion until the journey lets
  // it go.
  const journey = await startScriptTurn(test, {
    eventId: ROOT_EVENT,
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(SCRIPT),
      { text: ANSWER },
      { text: NOTED },
    ],
    completions: ["pass", "never", "held"],
  });
  const connector = await connectorOf();

  // The reply joins the running turn, and Pi queues it.
  await sendThreadMessage("message", REPLY_EVENT, REPLY_TS, REPLY_TEXT);
  await expect
    .poll(() => runInDurableObject(connector, readSteeredReplies), {
      timeout: 15_000,
    })
    .toEqual([REPLY_EVENT]);
  await expect
    .poll(() => runInDurableObject(journey.session, readSteeringStates), {
      timeout: 15_000,
    })
    .toEqual(["queued"]);
  expect(journey.requests).toHaveLength(2);

  // The process ends before the reply reaches the transcript. The next
  // process resumes the turn by itself, and the script reads again.
  const session = await loseSession(journey);
  await expect
    .poll(countCalls.bind(null, journey.completed), { timeout: 20_000 })
    .toBe(3);
  journey.releaseHeld();
  await deliverAfterConnectorLease(journey, session);
  await expect
    .poll(
      () => runInDurableObject(connector, readReceipt.bind(null, REPLY_EVENT)),
      { timeout: 20_000 },
    )
    .toBe("completed");
  expect(
    await runInDurableObject(connector, readReceipt.bind(null, ROOT_EVENT)),
  ).toBe("completed");

  // One answer that follows the reply. The model read the reply one time,
  // after the script's result, and the history holds it one time.
  expect(journey.slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWER },
  ]);
  expect(journey.requests).toHaveLength(3);
  const messages = messageList(journey.requests[2]);
  const scriptResult = messages.findIndex(isToolMessage);
  const steering = messages.findIndex(
    userMessageContaining.bind(null, REPLY_TEXT),
  );
  expect(scriptResult).toBeGreaterThan(-1);
  expect(steering).toBeGreaterThan(scriptResult);
  expect(
    messages.filter(userMessageContaining.bind(null, REPLY_TEXT)),
  ).toHaveLength(1);
  expect(
    await runInDurableObject(
      session,
      countHistoryEntries.bind(null, REPLY_TEXT),
    ),
  ).toBe(1);

  // The next turn holds the reply in its history one time. Its context, which
  // lists the thread's recent messages, also lists the reply: the Case
  // recorded it when the resumed turn ended.
  await sendThreadMessage("message", FOLLOW_EVENT, FOLLOW_TS, FOLLOW_TEXT);
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(2);
  expect(journey.requests).toHaveLength(4);
  const next = messageList(journey.requests[3]);
  expect(next.filter(userMessageIs.bind(null, REPLY_TEXT))).toHaveLength(1);
  const request = next.filter(isUserMessage).at(-1);
  expect(userMessageContaining(FOLLOW_TEXT, request)).toBe(true);
  expect(userMessageContaining(REPLY_TEXT, request)).toBe(true);
  expect(journey.slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWER },
    { thread: ROOT_TS, text: NOTED },
  ]);

  Object.assign(test.task.meta, {
    slackSteeringRecovery: {
      modelRequests: journey.requests.length,
      readCompletions: journey.completed,
      answeredRequestOrder: { scriptResult, steering },
      posts: journey.slack.messages.map(threadAndText),
    },
  });
}

/**
 * A turn that cannot resume ends, and the thread goes on (Refactor 15,
 * refactor 3).
 *
 * The scene is the one above, but the process ends at a point that the next
 * process cannot resume: Pi's record of the turn's submission is missing, as
 * after a loss between the start commit and the submission. The Session ends
 * the turn as a failed turn and sleeps; it does not quarantine. The queued
 * reply reads as withdrawn, so it returns to the queue as work of its own.
 * The first message keeps its failed turn, and the reply gets its own
 * answer at once: the Session takes later work.
 */
it(
  "ends a turn that cannot resume, so the thread's reply gets an answer",
  unresumableSteeringJourney,
  120_000,
);

const REPLY_ANSWER = "REPLY_ANSWERED_AFTER_LOSS";
const INTERRUPTED_NOTICE =
  "Sous Chef lost its connection to the running task, so this request did not finish. Some actions may have completed: check the results before you ask again.";

async function unresumableSteeringJourney(test: TestContext): Promise<void> {
  const journey = await startScriptTurn(test, {
    eventId: ROOT_EVENT,
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(SCRIPT),
      { text: REPLY_ANSWER },
    ],
    completions: ["pass", "never"],
  });
  const connector = await connectorOf();
  await sendThreadMessage("message", REPLY_EVENT, REPLY_TS, REPLY_TEXT);
  await expect
    .poll(() => runInDurableObject(connector, readSteeredReplies), {
      timeout: 15_000,
    })
    .toEqual([REPLY_EVENT]);
  await expect
    .poll(() => runInDurableObject(journey.session, readSteeringStates), {
      timeout: 15_000,
    })
    .toEqual(["queued"]);

  await runInDurableObject(journey.session, losePiSubmission);
  const session = await loseSession(journey);
  await expect
    .poll(readLifecycleKind.bind(null, session), { timeout: 20_000 })
    .toBe("sleeping");
  await runInDurableObject(connector, endCaseWorkLease);
  await runDurableObjectAlarm(connector);

  // The first message's attempts read its failed turn again; each one is
  // made due at once instead of after its wait.
  await expect
    .poll(
      async () => {
        await runInDurableObject(connector, makeCaseWorkDue);
        await runDurableObjectAlarm(connector);
        return runInDurableObject(
          connector,
          readReceipt.bind(null, REPLY_EVENT),
        );
      },
      { timeout: 60_000, interval: 500 },
    )
    .toBe("completed");
  // The first message keeps its failed turn: it never completes.
  expect(
    await runInDurableObject(connector, readReceipt.bind(null, ROOT_EVENT)),
  ).not.toBe("completed");
  expect(await runInDurableObject(connector, readSteeredReplies)).toEqual([]);
  expect(await runInDurableObject(session, readSteeringStates)).toEqual([
    "withdrawn",
  ]);
  expect(await readLifecycleKind(session)).toBe("sleeping");
  // The first message gets one notice that it did not finish, and the
  // reply gets its own answer.
  expect(journey.slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: INTERRUPTED_NOTICE },
    { thread: ROOT_TS, text: REPLY_ANSWER },
  ]);
  expect(journey.requests).toHaveLength(3);
  Object.assign(test.task.meta, {
    unresumableSteering: {
      steeringStates: await runInDurableObject(session, readSteeringStates),
      posts: journey.slack.messages.map(threadAndText),
    },
  });
}

/** Deletes Pi's record of the turn's submission, the record of a lost start. */
function losePiSubmission(_actor: unknown, ctx: DurableObjectState): void {
  ctx.storage.sql.exec("DELETE FROM submissions");
}

function readSteeringStates(
  _actor: unknown,
  ctx: DurableObjectState,
): string[] {
  return ctx.storage.sql
    .exec<{ state: string }>(
      "SELECT state FROM session_turn_steering_input ORDER BY admitted_at",
    )
    .toArray()
    .map(function state(row) {
      return row.state;
    });
}

function countHistoryEntries(
  text: string,
  _actor: unknown,
  ctx: DurableObjectState,
): number {
  return ctx.storage.sql
    .exec<{ payload: string }>("SELECT payload FROM session_harness_history")
    .toArray()
    .filter(function holdsText(row) {
      const stored: unknown = JSON.parse(row.payload);
      const entry = isRecord(stored) ? stored.entry : null;
      return (
        isRecord(entry) &&
        entry.kind === "user_input" &&
        JSON.stringify(entry.content).includes(text)
      );
    }).length;
}

function messageList(body: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function isToolMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "tool";
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}

async function connectorOf() {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const entry = entries.value.find(function isConnector(candidate) {
    return candidate.identity.objectKind === "connector";
  });
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return connectorActorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
}
