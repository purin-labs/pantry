import { runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "@purin-labs/agent/data/agent-operations";
import { network } from "./network";
import { connectorOf, registryEntries } from "./slack-follow-up-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  inspectSlackActors,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  shownSlackPost,
} from "./slack-journey-support";

/**
 * A conversation keeps the instructions it started with. A Slack thread that
 * started while the organisation had no agent runs on platform instructions,
 * and it must keep them when an agent installation becomes active later.
 *
 * The journey runs two turns of one thread with no installation, so its
 * Session holds a checkpoint made under platform instructions. Then one
 * installation becomes active:
 *
 * - the next reply in that thread completes on platform instructions;
 * - a new thread runs the agent's instructions and records its pin;
 * - a reply that addresses the agent in the old thread is refused with one
 *   post and no model call.
 */
it(
  "keeps a Slack thread on platform instructions when an agent installation becomes active in the middle of it",
  activationMidThreadJourney,
  180_000,
);

const OPERATOR = "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab";
const AGENT_INSTRUCTIONS =
  "Give every oven time in minutes and name the tray it applies to.";
const SECOND_THREAD_TS = "1787500400.000001";

/** Each answer has its own text: the context keeps one entry for each excerpt. */
const ANSWERS = [
  "The flour order is open.",
  "The flour order holds two trays.",
  "The second tray leaves the shop at noon.",
  "Tray one bakes for 18 minutes.",
] as const;

type Recorded = {
  readonly modelRequests: Record<string, unknown>[];
  readonly delivered: Record<string, string>[];
};

type TurnOutcome = {
  readonly outcome: string;
  readonly reason: string | null;
};

const COMPLETED: TurnOutcome = { outcome: "completed", reason: null };

async function activationMidThreadJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded: Recorded = { modelRequests: [], delivered: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, recorded),
    ),
  );
  const turn = runTurn.bind(null, fixture.connectorId, recorded);

  // Two turns with no installation. The thread runs on platform instructions.
  expect(
    await turn("Ev_PIN_ROOT", ROOT_TS, ROOT_TS, "open the flour order"),
  ).toEqual(COMPLETED);
  expect(
    await turn(
      "Ev_PIN_REPLY_1",
      "1787500000.000002",
      ROOT_TS,
      "how many trays",
    ),
  ).toEqual(COMPLETED);
  expect(recorded.delivered.map(textOf)).toEqual(ANSWERS.slice(0, 2));
  expect(recorded.modelRequests.map(carriesAgentInstructions)).toEqual([
    false,
    false,
  ]);
  expect(await pins()).toEqual([]);
  const firstThread = await inspectSlackActors(fixture.connectorId);
  if (!firstThread.case.ok) throw new Error("First thread's Case is missing");
  const assignment = firstThread.case.value.assignmentLifecycles[0]?.assignment;
  if (assignment === undefined)
    throw new Error("First thread has no assignment");
  // The Session holds a checkpoint, so the next turn restores it.
  const platformDigest = await checkpointInstructionDigest(
    firstThread.sessionId,
  );

  await installAgent();

  // The next reply stays on platform instructions and records no pin.
  expect(
    await turn(
      "Ev_PIN_REPLY_2",
      "1787500000.000003",
      ROOT_TS,
      "when does the second tray leave",
    ),
  ).toEqual(COMPLETED);
  expect(recorded.delivered.map(textOf)).toEqual(ANSWERS.slice(0, 3));
  expect(carriesAgentInstructions(recorded.modelRequests[2])).toBe(false);
  expect(await pins()).toEqual([]);
  expect(await checkpointInstructionDigest(firstThread.sessionId)).toBe(
    platformDigest,
  );

  // A thread that starts after the activation runs the agent and pins it.
  expect(
    await turn(
      "Ev_PIN_SECOND_ROOT",
      SECOND_THREAD_TS,
      SECOND_THREAD_TS,
      "how long does tray one bake",
    ),
  ).toEqual(COMPLETED);
  expect(recorded.delivered.map(textOf)).toEqual(ANSWERS.slice(0, 4));
  expect(recorded.delivered[3]?.thread_ts).toBe(SECOND_THREAD_TS);
  expect(carriesAgentInstructions(recorded.modelRequests[3])).toBe(true);
  const pinsAfterSecondThread = await pins();
  expect(pinsAfterSecondThread).toHaveLength(1);
  expect(pinsAfterSecondThread[0]?.installationId).toBe("installation_baker");
  expect(pinsAfterSecondThread[0]?.assignmentId).not.toBe(
    assignment.assignmentId,
  );

  // An address names another configuration than the old thread runs. The
  // turn is refused with one post. It calls no model and records no pin.
  expect(
    await turn(
      "Ev_PIN_ADDRESSED",
      "1787500000.000004",
      ROOT_TS,
      "Agent Baker: how long does tray two bake",
    ),
  ).toEqual(COMPLETED);
  expect(recorded.modelRequests).toHaveLength(4);
  expect(recorded.delivered).toHaveLength(5);
  const refusal = recorded.delivered[4];
  expect(refusal?.thread_ts).toBe(ROOT_TS);
  expect(ANSWERS).not.toContain(refusal?.text);
  expect(await pins()).toEqual(pinsAfterSecondThread);

  // The old thread's checkpoint still holds the platform instructions.
  expect(await checkpointInstructionDigest(firstThread.sessionId)).toBe(
    platformDigest,
  );

  Object.assign(test.task.meta, {
    slackAgentActivationMidThread: {
      turns: recorded.delivered.map(function summarise(post) {
        return { thread: post.thread_ts, text: post.text };
      }),
      agentInstructionsInModelRequest: recorded.modelRequests.map(
        carriesAgentInstructions,
      ),
      pins: await pins(),
      firstThreadAssignment: assignment.assignmentId,
    },
  });
}

/**
 * Send one Slack message and wait for the Connector to settle it or to set it
 * aside for a retry. A turn that completes has made its one post by then.
 */
async function runTurn(
  connectorId: string,
  recorded: Recorded,
  eventId: string,
  messageTs: string,
  threadTs: string,
  text: string,
): Promise<TurnOutcome> {
  const posts = recorded.delivered.length;
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: messageTs === threadTs ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs,
        text: messageTs === threadTs ? `<@U0PANTRY> ${text}` : text,
      }),
    ),
  );
  expect(response.status).toBe(200);
  const connector = await connectorOf(connectorId);
  await expect
    .poll(
      () => runInDurableObject(connector, readTurnOutcome.bind(null, eventId)),
      { timeout: 60_000, interval: 100 },
    )
    .not.toBeNull();
  const outcome = await runInDurableObject(
    connector,
    readTurnOutcome.bind(null, eventId),
  );
  if (outcome === null) throw new Error("The turn outcome is missing");
  if (outcome.outcome === "completed")
    expect(recorded.delivered).toHaveLength(posts + 1);
  return outcome;
}

/** The receipt of a settled message, or the reason of a message set aside. */
function readTurnOutcome(
  eventId: string,
  _actor: unknown,
  ctx: DurableObjectState,
): TurnOutcome | null {
  const receipt = ctx.storage.sql
    .exec<{ outcome: string; reason: string | null }>(
      "SELECT outcome, reason FROM connector_case_work_receipt WHERE event_id = ?",
      eventId,
    )
    .toArray()[0];
  if (receipt !== undefined)
    return { outcome: receipt.outcome, reason: receipt.reason };
  const work = ctx.storage.sql
    .exec<{ retry_reason: string | null }>(
      "SELECT retry_reason FROM connector_case_work WHERE event_id = ?",
      eventId,
    )
    .toArray()[0];
  return work === undefined || work.retry_reason === null
    ? null
    : { outcome: "retry", reason: work.retry_reason };
}

async function installAgent(): Promise<void> {
  const now = Date.now();
  const commands: AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_bakery",
      actorUserId: OPERATOR,
      now,
      name: "Bakery production",
      purpose: "Plan and follow the day's bakes.",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_baker",
      actorUserId: OPERATOR,
      now,
      displayName: "Baker",
      role: "production_planner",
      purpose: "Answer questions about the day's bakes.",
      instructions: AGENT_INSTRUCTIONS,
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_baker",
      actorUserId: OPERATOR,
      now,
      agentDefinitionId: "agent_baker",
      definitionRevision: 1,
      areaId: "area_bakery",
      responsibility: "Own the bake plan.",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands) {
    const applied = await applyAgentOperation(
      fixtureDatabase(),
      ORGANISATION_ID,
      command,
    );
    if (!applied.ok) throw new Error(applied.error.code);
  }
}

async function pins(): Promise<
  readonly { readonly assignmentId: string; readonly installationId: string }[]
> {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT assignment_id AS assignmentId, installation_id AS installationId
     FROM case_assignment_pin
     WHERE organisation_id = ?
     ORDER BY pinned_at`,
    )
    .bind(ORGANISATION_ID)
    .all<{ readonly assignmentId: string; readonly installationId: string }>();
  return rows.results;
}

/** The instruction digest of the Session's latest checkpoint. */
async function checkpointInstructionDigest(
  sessionId: Awaited<ReturnType<typeof inspectSlackActors>>["sessionId"],
): Promise<string> {
  const entry = (await registryEntries()).find(function isSession(candidate) {
    return (
      candidate.identity.objectKind === "session" &&
      candidate.identity.logicalObjectId === sessionId
    );
  });
  if (entry === undefined) throw new Error("Session registry entry missing");
  const inspected = await actorStub(
    env.SESSION,
    entry.physicalObjectName,
    entry.placement,
  ).inspectCanonicalSessionState({
    organisationId: ORGANISATION_ID,
    sessionId,
  });
  if (!inspected.ok) throw new Error(inspected.error.code);
  if (inspected.value.checkpoint.kind !== "current")
    throw new Error("The Session holds no checkpoint");
  return inspected.value.checkpoint.instructionDigest;
}

function textOf(post: Record<string, string> | undefined): string | undefined {
  return post?.text;
}

function carriesAgentInstructions(
  request: Record<string, unknown> | undefined,
): boolean {
  if (request === undefined) throw new Error("The model request is missing");
  return JSON.stringify(request).includes(AGENT_INSTRUCTIONS);
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Model request body is invalid");
  const answer = ANSWERS[recorded.modelRequests.length];
  if (answer === undefined) throw new Error("Unexpected model request");
  recorded.modelRequests.push(body);
  return openRouterText(
    answer,
    `chatcmpl_pin_${String(recorded.modelRequests.length)}`,
  );
}

async function respondToSlack(
  recorded: Recorded,
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const raw: unknown = slackPostFields(await request.json());
  if (!isStringRecord(raw)) throw new Error("Slack request body is invalid");
  const body = shownSlackPost(raw);
  if (params.method === "chat.postMessage") {
    recorded.delivered.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500900.${String(recorded.delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}
