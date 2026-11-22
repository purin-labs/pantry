import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { listPlacementActorRegistryEntries } from "@purin-labs/actor-runtime/actors/actor-registry";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { STEER_ANSWER_LOST_FAULT_KEY } from "../../src/actors/connector/steer-fault";
import { fixtureDatabase } from "./organisation-database";
import { network } from "./network";
import { readSteeredReplies } from "./slack-follow-up-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
  sendSlack,
  threadAndText,
  userMessageContaining,
} from "./slack-journey-support";

/**
 * A reply that steered a turn is read one time, though the Connector's
 * process ended between the steer and its record (Refactor 15, refactor 9).
 *
 * A person asks for a supplier check, and replies in the thread while the
 * turn's first model request runs. The Connector offers the reply to the
 * running turn. The Session admits the reply, and the Connector's call ends
 * at once after the Session's answer, as a process loss there would end it
 * (a fault key in the Connector's storage). The turn's next model request
 * holds the reply. The thread gets one answer that follows the reply, the
 * reply settles as part of that turn, and the model reads the reply one
 * time. The old Connector wrote its record of the steer only after the
 * Session answered, so the reply stayed in the queue and ran as a turn of
 * its own: the model read it two times and the thread got a second answer.
 */
it(
  "reads a steered reply once when the Connector's call ends between the steer and its record",
  steerParkLossJourney,
  120_000,
);

const ROOT_EVENT = "Ev_PARK_LOSS_ROOT";
const REPLY_EVENT = "Ev_PARK_LOSS_REPLY";
const REPLY_TS = "1787500000.000002";
const REPLY_TEXT = "Only the flour supplier, please.";
const ANSWER = "The flour supplier delivers on Friday.";
const SECOND_ANSWER = "Noted: only the flour supplier.";

/** The first model request waits while it is `held`. */
type Journey = {
  readonly requests: Record<string, unknown>[];
  model: "waiting" | "held" | "released";
};

async function steerParkLossJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const journey: Journey = { requests: [], model: "waiting" };
  test.onTestFinished(() => {
    journey.model = "released";
  });
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, journey),
    ),
    slack.handler,
  );

  await sendSlack(
    ROOT_EVENT,
    ROOT_TS,
    "<@U0PANTRY> check our next supplier deliveries",
  );
  await expect.poll(() => journey.model, { timeout: 30_000 }).toBe("held");
  const connector = await actorOf("connector", fixture.connectorId);
  const session = await actorOf("session", null);

  // The Connector's call ends right after the Session takes the reply.
  await runInDurableObject(connector, loseNextSteerAnswer);
  await sendSlack(REPLY_EVENT, REPLY_TS, REPLY_TEXT);
  await expect
    .poll(() => runInDurableObject(session, readSteeringStates), {
      timeout: 15_000,
    })
    .toEqual(["queued"]);
  await expect
    .poll(() => runInDurableObject(connector, faultUsed), { timeout: 15_000 })
    .toBe(true);

  // The turn reads the reply after the tool, and the queue goes on.
  journey.model = "released";
  await expect
    .poll(() => runInDurableObject(connector, readReceipts), {
      timeout: 60_000,
      interval: 500,
    })
    .toEqual({ [ROOT_EVENT]: "completed", [REPLY_EVENT]: "completed" });
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  // A turn of the reply's own would ask the model again within this time.
  await scheduler.wait(3_000);

  // The model read the reply one time, in the steered turn.
  expect(journey.requests).toHaveLength(2);
  const second = messageList(journey.requests[1]);
  expect(
    second.filter(userMessageContaining.bind(null, REPLY_TEXT)),
  ).toHaveLength(1);
  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWER },
  ]);
  expect(await runInDurableObject(connector, readSteeredReplies)).toEqual([]);

  Object.assign(test.task.meta, {
    steerParkLoss: {
      modelRequests: journey.requests.length,
      posts: slack.messages.map(threadAndText),
    },
  });
}

async function loseNextSteerAnswer(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.put(STEER_ANSWER_LOST_FAULT_KEY, true);
}

async function faultUsed(
  _actor: unknown,
  state: DurableObjectState,
): Promise<boolean> {
  return (await state.storage.get(STEER_ANSWER_LOST_FAULT_KEY)) === undefined;
}

async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  journey.requests.push(body);
  switch (journey.requests.length) {
    case 1:
      journey.model = "held";
      while (journey.model === "held") await scheduler.wait(5);
      return openRouterToolCall(
        "tool_search",
        { query: "supplier deliveries", limit: 1 },
        "call_supplier_search",
      );
    case 2:
      return openRouterText(ANSWER, "steered_answer");
    default:
      return openRouterText(SECOND_ANSWER, `answer_${journey.requests.length}`);
  }
}

function readReceipts(
  _actor: unknown,
  state: DurableObjectState,
): Record<string, string> {
  return Object.fromEntries(
    state.storage.sql
      .exec<{ event_id: string; outcome: string }>(
        "SELECT event_id, outcome FROM connector_case_work_receipt",
      )
      .toArray()
      .map((row) => [row.event_id, row.outcome]),
  );
}

function readSteeringStates(
  _actor: unknown,
  state: DurableObjectState,
): string[] {
  return state.storage.sql
    .exec<{ state: string }>(
      "SELECT state FROM session_turn_steering_input ORDER BY admitted_at",
    )
    .toArray()
    .map((row) => row.state);
}

function messageList(body: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

async function actorOf(
  kind: "connector" | "session",
  logicalId: string | null,
) {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const entry = entries.value.find(
    (candidate) =>
      candidate.identity.objectKind === kind &&
      (logicalId === null || candidate.identity.logicalObjectId === logicalId),
  );
  if (entry === undefined) throw new Error(`${kind} registry entry missing`);
  return kind === "connector"
    ? actorStub(
        env.CONNECTOR,
        entry.physicalObjectName,
        entry.placement,
      )
    : actorStub(env.SESSION, entry.physicalObjectName, entry.placement);
}
