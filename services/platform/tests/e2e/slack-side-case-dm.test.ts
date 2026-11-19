import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  WORKSPACE_ID,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  signedSlackRequest,
  slackEnvelopeFor,
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

/**
 * Journey 8 of Plan 74: a side Case in a Slack DM.
 *
 * A person asks Pantry in a DM. The agent proposes a side Case in the DM's
 * thread. A click by another member is refused to that member alone: a DM
 * belongs to its person. The person's own click starts a new thread in the
 * same DM, links it in the first thread, and runs the brief there. A reply in
 * the new thread runs in the new Case, which the DM's routing reaches.
 */
it(
  "starts a Slack side Case from a DM as a new thread in the same DM",
  slackSideCaseDmJourney,
  120_000,
);

const DM_CHANNEL_ID = "D0E2EACTOR";
const TITLE = "Renew the flour supplier contract";
const BRIEF =
  "The flour supplier contract ends on 31 October and no renewal is on file. Find the renewal terms and list what must be signed this week.";
const REPLY = "Use the terms of last year as a start.";
// The first thread and the brief share no word.
const ANSWERS = {
  parent:
    "Your bake list for Tuesday holds sourdough and baguettes. I added one more task.",
  sideCase: "I will look for the renewal terms of the flour contract.",
  reply: "I will compare them with last year's terms.",
} as const;

type Recorded = { readonly requests: Record<string, unknown>[] };

async function slackSideCaseDmJourney(test: TestContext): Promise<void> {
  await installSlackSideCaseFixture();
  // The person never chose an Organisation for their DMs. The workspace
  // serves one Organisation, so their first DM starts a Case there.
  const recorded: Recorded = { requests: [] };
  const slack = sideCaseSlack();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    ...slack.handlers,
  );

  const asked = await exports.default.fetch(
    await signedSlackRequest(
      dmEnvelope({
        eventId: "Ev74_SIDE_CASE_DM_ROOT",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> what is on the bake list for Tuesday?",
      }),
    ),
  );
  expect(asked.status).toBe(200);
  await expect
    .poll(() => answersIn(slack.posts(), ROOT_TS), { timeout: 30_000 })
    .toEqual([ANSWERS.parent]);
  const proposal = slack
    .posts()
    .find((post) => startButtonValue(post) !== null);
  if (proposal === undefined) throw new Error("No proposal in the DM");
  expect(proposal).toMatchObject({ channel: DM_CHANNEL_ID, threadTs: ROOT_TS });
  const click = {
    proposalId: startButtonValue(proposal) ?? "",
    channel: DM_CHANNEL_ID,
    threadTs: ROOT_TS,
    proposalTs: proposal.ts,
  };

  // Another member's click starts nothing. Only that member is told.
  const ingress = slackIngressWorker();
  const postsBefore = slack.posts().length;
  const foreign = await ingress.fetch(
    await signedStartClick({ ...click, user: PEER_SLACK_USER_ID }),
  );
  expect(foreign.status).toBe(200);
  await expect.poll(() => slack.ephemeral.length, { timeout: 15_000 }).toBe(1);
  expect(slack.ephemeral[0]).toContain("You cannot start this side Case.");
  expect(slack.posts()).toHaveLength(postsBefore);

  // The DM's person starts it: a new thread in the same DM.
  const started = await ingress.fetch(
    await signedStartClick({ ...click, user: USER_ID }),
  );
  expect(started.status).toBe(200);
  await expect
    .poll(() => newThreadRoots(slack.posts()).length, { timeout: 30_000 })
    .toBe(1);
  const root = newThreadRoots(slack.posts())[0];
  if (root === undefined) throw new Error("No new DM thread");
  expect(root.channel).toBe(DM_CHANNEL_ID);
  expect(shownText(root)).toContain(BRIEF);
  expect(shownText(root)).toContain(slackPermalink(DM_CHANNEL_ID, ROOT_TS));
  const link = slack
    .posts()
    .filter(
      (post) =>
        post.threadTs === ROOT_TS &&
        shownText(post).includes(slackPermalink(DM_CHANNEL_ID, root.ts)),
    );
  expect(link).toHaveLength(1);
  await expect
    .poll(() => answersIn(slack.posts(), root.ts), { timeout: 30_000 })
    .toEqual([ANSWERS.sideCase]);
  const firstTurn = recorded.requests[2];
  if (firstTurn === undefined) throw new Error("No side Case turn");
  // No turn of the first thread: organisational context may name it.
  expect(messageRoles(firstTurn)).toEqual(["system", "user"]);
  expect(currentRequest(firstTurn)).toContain(BRIEF);
  expect(currentRequest(firstTurn)).not.toContain("bake list");

  // A reply in the new DM thread runs in the new Case.
  const replied = await exports.default.fetch(
    await signedSlackRequest(
      dmEnvelope({
        eventId: "Ev74_SIDE_CASE_DM_REPLY",
        messageTs: "1787500300.000001",
        threadTs: root.ts,
        text: REPLY,
        eventType: "message",
      }),
    ),
  );
  expect(replied.status).toBe(200);
  await expect
    .poll(() => answersIn(slack.posts(), root.ts), { timeout: 30_000 })
    .toEqual([ANSWERS.sideCase, ANSWERS.reply]);
  const replyTurn = recorded.requests[3];
  if (replyTurn === undefined) throw new Error("No reply turn");
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
  expect(recorded.requests).toHaveLength(4);

  Object.assign(test.task.meta, {
    slackSideCaseDm: {
      modelRequests: recorded.requests.length,
      posts: slack.posts().map(summary),
      ephemeral: slack.ephemeral,
      proposal: await fixtureDatabase()
        .prepare(
          "SELECT source_kind AS sourceKind, status, source_channel_id AS channelId, destination_thread_ts AS destinationThreadTs FROM side_case_proposal WHERE organisation_id = ?",
        )
        .bind(ORGANISATION_ID)
        .all(),
    },
  });
}

function dmEnvelope(
  input: Readonly<{
    eventId: string;
    messageTs: string;
    threadTs: string;
    text: string;
    eventType?: "app_mention" | "message";
  }>,
): Record<string, unknown> {
  return slackEnvelopeFor({
    workspaceId: WORKSPACE_ID,
    channelId: DM_CHANNEL_ID,
    userId: USER_ID,
    eventType: input.eventType ?? "app_mention",
    eventId: input.eventId,
    messageTs: input.messageTs,
    threadTs: input.threadTs,
    text: input.text,
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
        "call_side_case_dm",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("side_case_proposed");
      return openRouterText(ANSWERS.parent, "side_case_dm_parent");
    case 3:
      return openRouterText(ANSWERS.sideCase, "side_case_dm_first");
    case 4:
      return openRouterText(ANSWERS.reply, "side_case_dm_reply");
    default:
      throw new Error("Unexpected model request");
  }
}

function newThreadRoots(posts: readonly SlackCall[]): SlackCall[] {
  return posts.filter((post) => post.threadTs === null);
}

function answersIn(posts: readonly SlackCall[], threadTs: string): string[] {
  return posts
    .filter((post) => post.threadTs === threadTs && post.blocks.length === 0)
    .map((post) => post.text);
}
