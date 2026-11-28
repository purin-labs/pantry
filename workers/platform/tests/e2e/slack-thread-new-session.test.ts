import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { changeAiAccount } from "./ai-account-support";
import { preparePortalChatJourney } from "./chat-journey-support";
import { FakeGemini, type GeminiAnswer } from "./gemini-support";
import { joinMember } from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { connectorOf, readReceipt } from "./slack-follow-up-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  WORKSPACE_ID,
  createRequiredGrant,
  openRouterText,
  signedSlackRequest,
  slackEnvelopeFor,
  slackSimulator,
} from "./slack-journey-support";

/**
 * An open Slack thread keeps the agent's earlier answers when its next
 * message starts a new Session (spec FND-03, spec FND-04, spec FND-05).
 *
 * A thread gets two answers from Purin AI. An admin then changes the AI
 * account to the organisation's Gemini key. The change raises the
 * configuration version, so the next message of the thread starts a new
 * Session on the Gemini route. Its model request holds the two earlier
 * answers of the agent, and the thread gets the Gemini answer. The admin then
 * replaces the key, which starts one more Session: its request holds the
 * answers of both earlier Sessions.
 *
 * An operator then writes in the same thread. A requester with another role
 * is another requester: the request of that Session holds the messages of the
 * thread's people, and it does not hold the answers that the agent gave to
 * the admin.
 */
it(
  "keeps the agent's earlier answers in an open Slack thread after a change of the AI account",
  slackThreadNewSessionJourney,
  180_000,
);

const FIRST_KEY = "AIzaE2ESlackThreadNewSessionJourney00001";
const SECOND_KEY = "AIzaE2ESlackThreadNewSessionJourney00002";
const GEMINI_SOURCE = { kind: "organisation_google_api_key" };
const CROISSANTS = "Twelve croissants are left on the rack.";
const BAGUETTES = "Six baguettes are left in the basket.";
const BAKE_MORE = "Yes: bake one more tray of croissants.";
const OVEN = "Set the oven to 190 degrees for that tray.";
const OPERATOR_ANSWER = "The tray goes in at four.";
const OPERATOR_SLACK_USER = "U0E2EOPERATOR";

async function slackThreadNewSessionJourney(test: TestContext): Promise<void> {
  const { session: admin, fixture } = await preparePortalChatJourney();
  const gemini = new FakeGemini(FIRST_KEY);
  gemini.issue(SECOND_KEY);
  gemini.install();
  const slack = slackSimulator();
  const purinAi = {
    answers: [CROISSANTS, BAGUETTES],
    requests: [] as string[],
  };
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerOnPurinAi.bind(null, purinAi),
    ),
  );
  /** One mention in the thread, and the texts of the thread after it. */
  async function askInThread(
    step: number,
    question: string,
    slackUser: string = USER_ID,
  ): Promise<(string | undefined)[]> {
    const eventId = `Ev_THREAD_NEW_SESSION_${String(step)}`;
    const accepted = await exports.default.fetch(
      await signedSlackRequest(
        slackEnvelopeFor({
          workspaceId: WORKSPACE_ID,
          channelId: CHANNEL_ID,
          userId: slackUser,
          eventType: "app_mention",
          eventId,
          messageTs: `1787500000.00000${String(step)}`,
          threadTs: ROOT_TS,
          text: `<@U0PANTRY> ${question}`,
        }),
      ),
    );
    expect(accepted.status).toBe(200);
    const connector = await connectorOf(fixture.connectorId);
    await expect
      .poll(
        () => runInDurableObject(connector, readReceipt.bind(null, eventId)),
        { timeout: 40_000 },
      )
      .toBe("completed");
    await expect
      .poll(slack.visibleMessageCount, { timeout: 15_000 })
      .toBe(step);
    return slack.messages.map(textOf);
  }

  // The thread starts on Purin AI and gets two answers.
  expect(await askInThread(1, "how many croissants are left?")).toEqual([
    CROISSANTS,
  ]);
  expect(await askInThread(2, "and how many baguettes?")).toEqual([
    CROISSANTS,
    BAGUETTES,
  ]);
  expect(purinAi.requests).toHaveLength(2);

  // The admin changes the AI account to the organisation's Gemini key.
  expect(
    await changeAiAccount(
      admin,
      ORGANISATION_ID,
      "thread-new-session-first-key",
      {
        selection: GEMINI_SOURCE,
        apiKey: FIRST_KEY,
      },
    ),
  ).toMatchObject({ status: 200, body: { selection: GEMINI_SOURCE } });

  // The next message gets its answer from Gemini, in a new Session. The
  // request holds what the agent said before the change.
  gemini.answers.push(geminiAnswer(BAKE_MORE));
  expect(await askInThread(3, "should we bake more of them?")).toEqual([
    CROISSANTS,
    BAGUETTES,
    BAKE_MORE,
  ]);
  expect(purinAi.requests).toHaveLength(2);
  expect(gemini.requestKeys).toEqual([FIRST_KEY]);
  const afterSourceChange = JSON.stringify(gemini.requests[0]?.body);
  expect(afterSourceChange).toContain(CROISSANTS);
  expect(afterSourceChange).toContain(BAGUETTES);
  expect(afterSourceChange).toContain("how many croissants are left?");

  // The admin replaces the key. The thread moves to one more Session, and
  // its request holds the answers of both earlier Sessions.
  expect(
    await changeAiAccount(
      admin,
      ORGANISATION_ID,
      "thread-new-session-second-key",
      {
        selection: GEMINI_SOURCE,
        apiKey: SECOND_KEY,
      },
    ),
  ).toMatchObject({ status: 200 });
  gemini.answers.push(geminiAnswer(OVEN));
  expect(await askInThread(4, "how hot for that tray?")).toEqual([
    CROISSANTS,
    BAGUETTES,
    BAKE_MORE,
    OVEN,
  ]);
  expect(gemini.requestKeys).toEqual([FIRST_KEY, SECOND_KEY]);
  const afterKeyChange = JSON.stringify(gemini.requests[1]?.body);
  expect(afterKeyChange).toContain(CROISSANTS);
  expect(afterKeyChange).toContain(BAGUETTES);
  expect(afterKeyChange).toContain(BAKE_MORE);
  expect(purinAi.requests).toHaveLength(2);

  // An operator joins the thread. The Session of that role reads the
  // messages of the people, and not the answers that the admin's turns got.
  await linkOperatorToSlack();
  gemini.answers.push(geminiAnswer(OPERATOR_ANSWER));
  expect(
    await askInThread(5, "when does the tray go in?", OPERATOR_SLACK_USER),
  ).toEqual([CROISSANTS, BAGUETTES, BAKE_MORE, OVEN, OPERATOR_ANSWER]);
  const operatorRequest = JSON.stringify(gemini.requests[2]?.body);
  expect(operatorRequest).toContain("how hot for that tray?");
  for (const answer of [CROISSANTS, BAGUETTES, BAKE_MORE, OVEN])
    expect(operatorRequest).not.toContain(answer);

  Object.assign(test.task.meta, {
    slackThreadNewSession: {
      slackThread: slack.messages.map(textOf),
      purinAiRequests: purinAi.requests.length,
      geminiRequestsByKey: gemini.requestKeys.map(keyName),
      earlierAnswersInRequestAfterSourceChange: [CROISSANTS, BAGUETTES].filter(
        (answer) => afterSourceChange.includes(answer),
      ),
      earlierAnswersInRequestAfterKeyChange: [
        CROISSANTS,
        BAGUETTES,
        BAKE_MORE,
      ].filter((answer) => afterKeyChange.includes(answer)),
      earlierAnswersInRequestOfAnotherRole: [
        CROISSANTS,
        BAGUETTES,
        BAKE_MORE,
        OVEN,
      ].filter((answer) => operatorRequest.includes(answer)),
    },
  });
}

/**
 * An operator of the Organisation with a verified Slack identity in the
 * workspace of the thread, and the grant to read the Case context.
 */
async function linkOperatorToSlack(): Promise<void> {
  const operator = await joinMember(
    ORGANISATION_ID,
    "e2e-thread-new-session-operator",
    "operator",
  );
  await fixtureDatabase()
    .prepare(
      `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       )
       SELECT organisation_id, workspace_connection_id, workspace_id, ?, ?,
              verified_at, verified_by
         FROM external_identity_link
        WHERE organisation_id = ? AND external_user_id = ?`,
    )
    .bind(OPERATOR_SLACK_USER, operator.userId, ORGANISATION_ID, USER_ID)
    .run();
  await createRequiredGrant({
    grantId: "grant_thread_new_session_operator_read",
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
}

function geminiAnswer(text: string): GeminiAnswer {
  return () => [{ text }];
}

function textOf(post: Record<string, string>): string | undefined {
  return post.text;
}

function keyName(apiKey: string): string {
  return apiKey === FIRST_KEY ? "first key" : "second key";
}

async function answerOnPurinAi(
  purinAi: { readonly answers: string[]; readonly requests: string[] },
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  purinAi.requests.push(JSON.stringify(await request.json()));
  const answer = purinAi.answers.shift();
  if (answer === undefined) throw new Error("No Purin AI answer is prepared");
  return openRouterText(
    answer,
    `thread_new_session_${String(purinAi.requests.length)}`,
  );
}
