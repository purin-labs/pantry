import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { HttpResponse, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import { connectorOf } from "./slack-follow-up-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";
import {
  PEER_SLACK_USER_ID,
  installSlackSideCaseFixture,
  assistantTexts,
  currentRequest,
  lastUserText,
  messageRoles,
  shownText,
  sideCaseSlack,
  signedStartClick,
  slackIngressWorker,
  slackPermalink,
  startButtonValue,
  summary,
  type SlackCall,
} from "./slack-side-case-support";
import { runInDurableObject } from "cloudflare:test";
import { SIDE_CASE_START_LEASE_MS } from "../../src/chat/side-case-transition";

/**
 * Journey 7 of Plan 74: a side Case in a Slack channel.
 *
 * A person asks Pantry about tomorrow's order. The agent finds a fault that
 * nobody asked about and proposes it as a side Case: one message in the
 * thread with a Start button. Another member clicks Start twice, as a double
 * click does. Pantry posts one new thread in the same channel that links to
 * the first thread, links the new thread in the first thread, and runs the
 * brief there as the first message of the member who clicked. The new turn
 * reads the brief and none of the first thread. A reply in the new thread
 * runs in the new Case, not in the first one. A click by the first person
 * after the start is refused to that person alone.
 */
it(
  "starts a Slack side Case as a new thread in the same channel",
  slackSideCaseJourney,
  120_000,
);

/**
 * Refactor 15: a start that stops does not hold its proposal for good.
 *
 * A member clicks Start, and Slack refuses the new thread's root, so the
 * start stops after its claim. That member does not click again. While the
 * start's lease holds, another click is refused. When the lease ends, the
 * first person clicks Start, and the side Case starts for that person in a
 * new thread, with one run of the brief.
 */
it(
  "lets another member start a side Case whose first start stopped",
  lapsedStartJourney,
  120_000,
);

const PARENT_REQUEST = "<@U0PANTRY> check tomorrow's croissant order";
const TITLE = "Check the oven 2 temperature probe";
const BRIEF =
  "Oven 2 baked 40 degrees below its set point in three bakes today. Compare the probe reading with the bake log and tell the bakers if the probe must be replaced.";
const REPLY = "The bakers changed the probe battery at noon.";
// The first thread and the brief share no word, so the organisational
// context of the new turn does not tie the side Case to the first thread.
const ANSWERS = {
  parent:
    "Tomorrow's order holds 120 croissants. I also suggested a separate task.",
  sideCase: "I will compare the oven 2 probe with the bake log.",
  reply: "Then compare only the bakes after noon.",
} as const;

type Recorded = { readonly requests: Record<string, unknown>[] };

async function slackSideCaseJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackSideCaseFixture();
  const recorded: Recorded = { requests: [] };
  const slack = sideCaseSlack();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    ...slack.handlers,
  );

  // The agent answers the person and proposes the fault it found.
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev74_SIDE_CASE_ROOT",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: PARENT_REQUEST,
      }),
    ),
  );
  expect(asked.status).toBe(200);
  await expect
    .poll(() => answerIn(slack.posts(), ROOT_TS, ANSWERS.parent), {
      timeout: 30_000,
    })
    .toBe(true);
  const proposal = slack
    .posts()
    .find((post) => startButtonValue(post) !== null);
  if (proposal === undefined) throw new Error("No proposal in the thread");
  const proposalId = startButtonValue(proposal) ?? "";
  expect(proposal).toMatchObject({ channel: CHANNEL_ID, threadTs: ROOT_TS });
  expect(shownText(proposal)).toContain(TITLE);
  expect(shownText(proposal)).toContain(BRIEF);
  expect(recorded.requests).toHaveLength(2);

  // Another member clicks Start twice. Slack sends the clicks to the ingress
  // Worker, which gives them to the platform Worker.
  const ingress = slackIngressWorker();
  const click = {
    proposalId,
    user: PEER_SLACK_USER_ID,
    channel: CHANNEL_ID,
    threadTs: ROOT_TS,
    proposalTs: proposal.ts,
  };
  // A click whose signature does not verify is refused and starts nothing.
  const forged = await signedStartClick(click);
  forged.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
  expect((await ingress.fetch(forged)).status).toBe(401);
  const clicks = await Promise.all([
    ingress.fetch(await signedStartClick(click)),
    ingress.fetch(await signedStartClick(click)),
  ]);
  expect(clicks.map((answer) => answer.status)).toEqual([200, 200]);
  expect(ingress.forwarded).toEqual([
    "POST /slack/interactions",
    "POST /slack/interactions",
    "POST /slack/interactions",
  ]);
  await expect
    .poll(() => newThreadRoots(slack.posts()).length, { timeout: 30_000 })
    .toBe(1);
  const root = newThreadRoots(slack.posts())[0];
  if (root === undefined) throw new Error("No new thread");
  expect(root.channel).toBe(CHANNEL_ID);
  expect(shownText(root)).toContain(TITLE);
  expect(shownText(root)).toContain(BRIEF);
  expect(shownText(root)).toContain(slackPermalink(CHANNEL_ID, ROOT_TS));
  expect(shownText(root)).toContain(`<@${PEER_SLACK_USER_ID}>`);

  // The brief runs in the new thread for the member who clicked.
  await expect
    .poll(() => answerIn(slack.posts(), root.ts, ANSWERS.sideCase), {
      timeout: 30_000,
    })
    .toBe(true);
  const firstTurn = recorded.requests[2];
  if (firstTurn === undefined) throw new Error("No side Case turn");
  // The side Case holds no turn of the first thread: one system message and
  // the person's request, which is the brief. Organisational context that
  // any new Case reads may still name the first thread's messages.
  expect(messageRoles(firstTurn)).toEqual(["system", "user"]);
  expect(currentRequest(firstTurn)).toContain(BRIEF);
  expect(currentRequest(firstTurn)).not.toContain("croissant");
  expect(JSON.stringify(firstTurn)).toContain(
    "This thread started from a side Case proposal",
  );

  // The first thread gets one line with a link to the new thread, and the
  // proposal loses its button.
  const link = slack
    .posts()
    .filter(
      (post) =>
        post.threadTs === ROOT_TS &&
        shownText(post).includes(slackPermalink(CHANNEL_ID, root.ts)),
    );
  expect(link).toHaveLength(1);
  expect(shownText(link[0] as SlackCall)).toContain(
    `<@${PEER_SLACK_USER_ID}> started`,
  );
  const changed = slack.calls.filter(
    (call) => call.method === "chat.update" && call.ts === proposal.ts,
  );
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.map(startButtonValue)).not.toContain(proposalId);

  // A reply in the new thread runs in the new Case.
  const replied = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev74_SIDE_CASE_REPLY",
        messageTs: "1787500300.000001",
        threadTs: root.ts,
        text: REPLY,
      }),
    ),
  );
  expect(replied.status).toBe(200);
  await expect
    .poll(() => answerIn(slack.posts(), root.ts, ANSWERS.reply), {
      timeout: 30_000,
    })
    .toBe(true);
  const replyTurn = recorded.requests[3];
  if (replyTurn === undefined) throw new Error("No reply turn");
  // The reply turn holds the side Case's own turn and none of the first
  // thread's.
  expect(messageRoles(replyTurn)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
  expect(lastUserText(replyTurn)).toContain(REPLY);
  expect(JSON.stringify(replyTurn)).toContain(BRIEF);
  expect(assistantTexts(replyTurn)).toEqual([JSON.stringify(ANSWERS.sideCase)]);
  expect(answersIn(slack.posts(), ROOT_TS)).toEqual([ANSWERS.parent]);

  // The first person clicks after the start: only that person is told.
  const postsBefore = slack.posts().length;
  const late = await ingress.fetch(
    await signedStartClick({ ...click, user: USER_ID }),
  );
  expect(late.status).toBe(200);
  await expect
    .poll(() => slack.ephemeral, { timeout: 15_000 })
    .toEqual(["Another person already started this side Case."]);
  expect(slack.posts()).toHaveLength(postsBefore);
  expect(recorded.requests).toHaveLength(4);

  // The first work of the side Case ran for the member who clicked.
  const connector = await connectorOf(fixture.connectorId);
  const sideCaseWork = await runInDurableObject(connector, readSideCaseWork);
  expect(sideCaseWork).toEqual([
    { outcome: "completed", principalId: fixture.peerPersonId },
  ]);

  Object.assign(test.task.meta, {
    slackSideCase: {
      proposalId,
      modelRequests: recorded.requests.length,
      posts: slack.posts().map(summary),
      changes: changed.map(summary),
      ephemeral: slack.ephemeral,
      sideCaseWork,
      proposal: await fixtureDatabase()
        .prepare(
          "SELECT source_kind AS sourceKind, status, source_channel_id AS channelId, source_thread_ts AS sourceThreadTs, destination_thread_ts AS destinationThreadTs, destination_case_id AS destinationCaseId FROM side_case_proposal WHERE organisation_id = ?",
        )
        .bind(ORGANISATION_ID)
        .all(),
    },
  });
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  switch (recorded.requests.length) {
    case 1:
      expect(offeredToolNames(body)).toContain("propose_side_case");
      return openRouterToolCall(
        "propose_side_case",
        { title: TITLE, brief: BRIEF },
        "call_side_case",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("side_case_proposed");
      return openRouterText(ANSWERS.parent, "side_case_parent");
    case 3:
      return openRouterText(ANSWERS.sideCase, "side_case_first");
    case 4:
      return openRouterText(ANSWERS.reply, "side_case_reply");
    default:
      throw new Error("Unexpected model request");
  }
}

/** The new top-level messages: the roots of side Case threads. */
function newThreadRoots(posts: readonly SlackCall[]): SlackCall[] {
  return posts.filter((post) => post.threadTs === null);
}

function answersIn(posts: readonly SlackCall[], threadTs: string): string[] {
  return posts
    .filter((post) => post.threadTs === threadTs && post.blocks.length === 0)
    .map((post) => post.text);
}

function answerIn(
  posts: readonly SlackCall[],
  threadTs: string,
  answer: string,
): boolean {
  return answersIn(posts, threadTs).includes(answer);
}

/** How the side Case's first work settled, and for whom it ran. */
function readSideCaseWork(
  _actor: unknown,
  ctx: DurableObjectState,
): { readonly outcome: string; readonly principalId: unknown }[] {
  return ctx.storage.sql
    .exec<{ outcome: string; stable_command: string }>(
      "SELECT outcome, stable_command FROM connector_case_work_receipt WHERE event_id LIKE 'sidecase!_%' ESCAPE '!'",
    )
    .toArray()
    .map(function settled(row) {
      const command: unknown = JSON.parse(row.stable_command);
      return {
        outcome: row.outcome,
        principalId: isRecord(command) ? command.principalId : null,
      };
    });
}

async function lapsedStartJourney(test: TestContext): Promise<void> {
  await installSlackSideCaseFixture();
  const recorded: Recorded = { requests: [] };
  const slack = sideCaseSlack();
  // Slack refuses the first root of a new thread, one time.
  let refuseRoot = true;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    http.post(
      "https://slack.com/api/chat.postMessage",
      async function refuseFirstRoot({ request }) {
        const body: unknown = await request.clone().json();
        if (!refuseRoot || !isRecord(body) || body.thread_ts !== undefined)
          return undefined;
        refuseRoot = false;
        return HttpResponse.json({ ok: false, error: "fatal_error" });
      },
    ),
    ...slack.handlers,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev74_SIDE_CASE_LAPSED_ROOT",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: PARENT_REQUEST,
      }),
    ),
  );
  expect(asked.status).toBe(200);
  await expect
    .poll(() => answerIn(slack.posts(), ROOT_TS, ANSWERS.parent), {
      timeout: 30_000,
    })
    .toBe(true);
  const proposal = slack
    .posts()
    .find((post) => startButtonValue(post) !== null);
  if (proposal === undefined) throw new Error("No proposal in the thread");
  const proposalId = startButtonValue(proposal) ?? "";
  const ingress = slackIngressWorker();
  const click = {
    proposalId,
    user: PEER_SLACK_USER_ID,
    channel: CHANNEL_ID,
    threadTs: ROOT_TS,
    proposalTs: proposal.ts,
  };

  // The member's start stops: Slack refused the new thread.
  expect((await ingress.fetch(await signedStartClick(click))).status).toBe(200);
  await expect
    .poll(() => slack.ephemeral, { timeout: 15_000 })
    .toEqual([
      "The server could not start this side Case. Click Start again to continue.",
    ]);
  expect(newThreadRoots(slack.posts())).toEqual([]);

  // While the start's lease holds, the first person cannot take it over.
  const first = { ...click, user: USER_ID };
  expect((await ingress.fetch(await signedStartClick(first))).status).toBe(200);
  await expect.poll(() => slack.ephemeral.length, { timeout: 15_000 }).toBe(2);
  expect(slack.ephemeral[1]).toBe(
    "Another person already started this side Case.",
  );

  // The lease ends: the claim is older than the lease.
  const moved = await fixtureDatabase()
    .prepare(
      "UPDATE side_case_proposal SET decided_at = decided_at - ? WHERE organisation_id = ? AND proposal_id = ? AND status = 'starting'",
    )
    .bind(SIDE_CASE_START_LEASE_MS + 1_000, ORGANISATION_ID, proposalId)
    .run();
  expect(moved.meta.changes).toBe(1);

  // The first person starts the side Case now, in one new thread.
  expect((await ingress.fetch(await signedStartClick(first))).status).toBe(200);
  await expect
    .poll(() => newThreadRoots(slack.posts()).length, { timeout: 30_000 })
    .toBe(1);
  const root = newThreadRoots(slack.posts())[0];
  if (root === undefined) throw new Error("No new thread");
  expect(shownText(root)).toContain(`<@${USER_ID}>`);
  expect(shownText(root)).not.toContain(`<@${PEER_SLACK_USER_ID}>`);
  await expect
    .poll(() => answerIn(slack.posts(), root.ts, ANSWERS.sideCase), {
      timeout: 30_000,
    })
    .toBe(true);
  expect(currentRequest(recorded.requests[2] ?? {})).toContain(BRIEF);
  expect(recorded.requests).toHaveLength(3);
  expect(slack.ephemeral).toHaveLength(2);
  const stored = await fixtureDatabase()
    .prepare(
      "SELECT status, decided_by_slack_user_id AS starter, destination_thread_ts AS threadTs FROM side_case_proposal WHERE organisation_id = ? AND proposal_id = ?",
    )
    .bind(ORGANISATION_ID, proposalId)
    .first();
  expect(stored).toEqual({
    status: "started",
    starter: USER_ID,
    threadTs: root.ts,
  });
  Object.assign(test.task.meta, {
    slackLapsedSideCaseStart: {
      proposalId,
      ephemeral: slack.ephemeral,
      posts: slack.posts().map(summary),
      proposal: stored,
    },
  });
}
