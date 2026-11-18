import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  readOrganisationCodexConnection,
  runWeeklyChatGptLoginRefresh,
} from "../../src/models/codex-connection";
import { issueControlSession } from "../../src/data/control-plane";
import {
  CHATGPT_ACCOUNT_ID,
  FakeChatGpt,
  FakeOpenAiApi,
  FakeOpenAiSignIn,
  connectChatGptSignIn,
  connectChatGptSubscription,
  connectOpenAiApiKey,
  fixtureUser,
  lastToolOutput,
  offeredTools,
  textAnswer,
  type ChatGptAnswer,
  type ChatGptModelRequest,
} from "./chatgpt-subscription-support";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  installDiscoveryActorFixture,
  readSlackMessageText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * Plan 72: the ChatGPT subscription route runs on Pi. Two Slack threads start
 * at the same time with a sign-in whose access token is about to expire. Pi
 * calls a tool through the ChatGPT backend and answers once in each thread,
 * and OpenAI's authorization server sees one refresh. A model request that
 * chatgpt.com refuses with a challenge page gets one notice and leaves the
 * thread open. After OpenAI refuses a later refresh, the connection asks for
 * a new sign-in and no request repeats the exchange.
 *
 * Plan 73: the fake OpenAI refuses each request that does not leave through
 * the model exit Worker, as OpenAI refuses a request from Hong Kong. So the
 * sign-in, the allowance reads, the refresh and every model request pass
 * through it. The exit Worker refuses a host outside its list and sends
 * nothing.
 *
 * Plan 75: the fake chatgpt.com blocks each request that leaves from a
 * Worker, as chatgpt.com does in production, and accepts it from the
 * ChatGPT exit container. So every model request and allowance read passes
 * through the ChatGPT exit, while the sign-in and the refresh still use the
 * model exit Worker. Each exit refuses the other's hosts.
 */
it(
  "answers Slack threads on Pi through the ChatGPT subscription with one shared token refresh",
  subscriptionSlackJourney,
  120_000,
);

/**
 * Plan 72: a sign-in that no turn uses still refreshes every week. The
 * 15-minute cron refreshes a sign-in whose last refresh is older than seven
 * days one time, and leaves a newer one alone. A Slack turn that needs a
 * token while that refresh runs waits for it, and OpenAI sees one refresh.
 * When OpenAI refuses the weekly refresh, Portal asks for a new sign-in.
 */
it(
  "refreshes a week-old ChatGPT sign-in once at the cron, beside a Slack turn",
  weeklyRefreshJourney,
  120_000,
);

/**
 * Plan 74B: the subscription route runs on api.openai.com through "Sign in
 * with ChatGPT". The owner signs in by pasting the callback address. Two
 * Slack threads start at the same time with an access token that is about
 * to expire: OpenAI sees one refresh, and Pi calls a tool and answers once
 * in each thread, through the model exit Worker. A request that OpenAI
 * refuses at the usage limit gets one notice and leaves the thread open.
 * The next sign-in of the organisation reuses its issued client and host
 * id, so OpenAI can skip the consent screen. When OpenAI refuses a refresh,
 * the connection asks for a new sign-in and no request repeats the
 * exchange.
 */
it(
  "answers Slack threads on api.openai.com through Sign in with ChatGPT with one shared token refresh",
  signInSlackJourney,
  120_000,
);

/**
 * The organisation's own OpenAI API key: OpenAI refuses the first request of
 * a thread at the rate limit. The refusal used no tokens: the thread gets
 * one notice, and the next message in the thread answers with the same key,
 * through the model exit Worker.
 */
it(
  "answers the next message of a Slack thread after OpenAI refuses the organisation's API key at the rate limit",
  apiKeyRefusalSlackJourney,
  120_000,
);

const FIRST_THREAD = "1787500300.000001";
const SECOND_THREAD = "1787500400.000001";
const THIRD_THREAD = "1787500500.000001";
const WEEKLY_THREAD = "1787500700.000001";
const DAY_MS = 24 * 60 * 60 * 1_000;
const CHALLENGED_THREAD = "1787500600.000001";
const P74_FIRST_THREAD = "1787500800.000001";
const P74_SECOND_THREAD = "1787500900.000001";
const P74_REFUSED_THREAD = "1787501000.000001";
const P74_LIMITED_THREAD = "1787501100.000001";
const KEY_LIMITED_THREAD = "1787501200.000001";
const ORGANISATION_OPENAI_KEY = "sk-proj-e2e-organisation-openai-key-0001";

async function subscriptionSlackJourney(test: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const chatgpt = new FakeChatGpt();
  chatgpt.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  chatgpt.answer = answerWithIntegrationList;

  // The sign-in gives an access token that expires within five minutes.
  chatgpt.accessTokenLifetimeSeconds = 120;
  await connectChatGptSubscription(chatgpt);
  const signedIn = await readConnection();
  expect(signedIn).toMatchObject({
    kind: "connected",
    planType: "pro",
    allowance: { kind: "available", usedPercent: 25, credits: "available" },
  });
  chatgpt.accessTokenLifetimeSeconds = 3_600;
  const refreshAnswered = Promise.withResolvers<void>();
  chatgpt.refreshGate = refreshAnswered.promise;

  // Both threads start before the refresh answers. The first Session holds
  // the refresh lease while the second Session asks for the token.
  expect(await sendMention("Ev_P72_FIRST", FIRST_THREAD)).toBe("case_accepted");
  await expect
    .poll(chatgpt.refreshCount.bind(chatgpt), { timeout: 15_000 })
    .toBe(1);
  expect(await sendMention("Ev_P72_SECOND", SECOND_THREAD)).toBe(
    "case_accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(chatgpt.modelRequestCount()).toBe(0);
  refreshAnswered.resolve();
  await expect
    .poll(threadAnswers.bind(null, slack.messages, FIRST_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  await expect
    .poll(threadAnswers.bind(null, slack.messages, SECOND_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  expect(chatgpt.refreshCount()).toBe(1);

  // Each thread made two model requests: the tool call, then the answer.
  const requests = [...chatgpt.modelRequests];
  expect(requests).toHaveLength(4);
  const cacheKeys = new Set(requests.map(promptCacheKey));
  expect(cacheKeys.size).toBe(2);
  for (const request of requests) {
    expect(chatgpt.accepts(request.headers.authorization)).toBe(true);
    expect(request.headers).toMatchObject({
      originator: "pi",
      "chatgpt-account-id": CHATGPT_ACCOUNT_ID,
      "content-encoding": "zstd",
      accept: "text/event-stream",
    });
    expect(request.headers["session-id"]).toBe(promptCacheKey(request));
    expect(request.body).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      reasoning: { effort: "high" },
    });
  }
  const toolOutputs = requests.map(lastToolOutput).filter(isText);
  expect(toolOutputs).toHaveLength(2);
  for (const output of toolOutputs)
    expect(output).toContain("integration_ref_");

  // chatgpt.com refuses the first model request of a thread with a challenge
  // page. The refusal used no tokens: the thread gets one notice, the
  // sign-in stays connected, and the next message in the thread answers.
  chatgpt.modelChallenges = 1;
  expect(await sendMention("Ev_P72_CHALLENGED", CHALLENGED_THREAD)).toBe(
    "case_accepted",
  );
  await expect
    .poll(threadAnswers.bind(null, slack.messages, CHALLENGED_THREAD), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const challengeNotice = threadAnswers(slack.messages, CHALLENGED_THREAD);
  expect(chatgpt.challengedRequests).toBe(1);
  expect(await readConnection()).toMatchObject({ kind: "connected" });
  expect(
    await sendReply(
      "Ev_P72_CHALLENGED_AGAIN",
      "1787500600.000002",
      CHALLENGED_THREAD,
    ),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, CHALLENGED_THREAD), {
      timeout: 30_000,
    })
    .toEqual([...challengeNotice, "Two integrations answer here."]);

  // A later sign-in whose refresh OpenAI refuses.
  chatgpt.accessTokenLifetimeSeconds = 120;
  await connectChatGptSubscription(chatgpt, { reconnect: true });
  chatgpt.refuseRefresh = true;
  const modelRequestsBefore = chatgpt.modelRequestCount();
  expect(await sendMention("Ev_P72_REFUSED", THIRD_THREAD)).toBe(
    "case_accepted",
  );
  await expect.poll(readConnection, { timeout: 30_000 }).toMatchObject({
    kind: "action_required",
    reason: "authorization_expired",
  });
  await expect
    .poll(threadAnswers.bind(null, slack.messages, THIRD_THREAD), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const refusalNotice = threadAnswers(slack.messages, THIRD_THREAD);
  // A second message finds no route: it reaches no model and repeats no
  // exchange.
  expect(
    await sendReply("Ev_P72_REFUSED_AGAIN", "1787500500.000002", THIRD_THREAD),
  ).toBe("case_accepted");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(threadAnswers(slack.messages, THIRD_THREAD)).toEqual(refusalNotice);
  expect(chatgpt.refreshCount()).toBe(2);
  expect(chatgpt.modelRequestCount()).toBe(modelRequestsBefore);
  const portal = await readPortalConnection();
  expect(portal).toMatchObject({
    ok: true,
    connection: { kind: "action_required", reason: "authorization_expired" },
  });

  // Every request to OpenAI left through its exit: the fake refused none
  // for its location, and no chatgpt.com request left from a Worker, which
  // chatgpt.com blocks (Plan 75).
  expect(chatgpt.directRequests).toEqual([]);
  expect(chatgpt.workerRequests).toEqual([]);
  expect(chatgpt.usageReads.length).toBeGreaterThan(0);
  const exitRefusals = await sendOutsideModelExitHosts();

  Object.assign(test.task.meta, {
    plan75ChatGptExit: {
      workerRequests: chatgpt.workerRequests,
    },
    plan73ModelExit: {
      directRequests: chatgpt.directRequests,
      tokenRequests: chatgpt.tokenRequests.map((request) => request.grant_type),
      usageReads: chatgpt.usageReads.length,
      modelRequests: chatgpt.modelRequestCount(),
      exitRefusals,
    },
    plan72SubscriptionSlack: {
      refreshes: chatgpt.refreshCount(),
      modelRequests: requests.map((request) => ({
        thread:
          promptCacheKey(request) === promptCacheKey(requests[0]!)
            ? "first-session"
            : "second-session",
        model: request.body.model,
        reasoning: request.body.reasoning,
        tools: offeredTools(request).length,
        toolOutput: lastToolOutput(request) !== null,
      })),
      answers: {
        first: threadAnswers(slack.messages, FIRST_THREAD),
        second: threadAnswers(slack.messages, SECOND_THREAD),
        refused: refusalNotice,
        challenged: threadAnswers(slack.messages, CHALLENGED_THREAD),
      },
      afterRefusal: portal,
    },
  });
}

async function signInSlackJourney(test: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const openai = new FakeOpenAiSignIn();
  openai.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  openai.answer = answerWithIntegrationList;

  // The sign-in gives an access token that expires within five minutes.
  openai.accessTokenLifetimeSeconds = 120;
  await connectChatGptSignIn(openai);
  const signedIn = await readConnection();
  expect(signedIn).toMatchObject({
    kind: "connected",
    signIn: "chatgpt_agent",
    planType: "plus",
    allowance: { kind: "not_reported" },
  });
  const firstAuthorize = authorizeParams(openai.authorizeRequests[0]);
  expect(firstAuthorize).toMatchObject({
    client_id: "dynamic_agent_client",
    agent_name_hint: "Seams Sous Chef",
    redirect_uri: "http://127.0.0.1:1455/auth/callback",
  });
  openai.accessTokenLifetimeSeconds = 3_600;
  const refreshAnswered = Promise.withResolvers<void>();
  openai.refreshGate = refreshAnswered.promise;

  // Both threads start before the refresh answers. The first Session holds
  // the refresh lease while the second Session asks for the token.
  expect(await sendMention("Ev_P74_FIRST", P74_FIRST_THREAD)).toBe(
    "case_accepted",
  );
  await expect
    .poll(openai.refreshCount.bind(openai), { timeout: 15_000 })
    .toBe(1);
  expect(await sendMention("Ev_P74_SECOND", P74_SECOND_THREAD)).toBe(
    "case_accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(openai.modelRequestCount()).toBe(0);
  refreshAnswered.resolve();
  await expect
    .poll(threadAnswers.bind(null, slack.messages, P74_FIRST_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  await expect
    .poll(threadAnswers.bind(null, slack.messages, P74_SECOND_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  expect(openai.refreshCount()).toBe(1);

  // Each thread made two requests to the Responses API: the tool call, then
  // the answer. Each carried the user access token and only the fields that
  // this route accepts.
  const requests = [...openai.modelRequests];
  expect(requests).toHaveLength(4);
  expect(new Set(requests.map(promptCacheKey)).size).toBe(2);
  for (const request of requests) {
    expect(openai.accepts(request.headers.authorization)).toBe(true);
    expect(request.body).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      reasoning: { effort: "high" },
    });
  }
  const toolOutputs = requests.map(lastToolOutput).filter(isText);
  expect(toolOutputs).toHaveLength(2);
  for (const output of toolOutputs)
    expect(output).toContain("integration_ref_");

  // OpenAI refuses the first request of a thread at the usage limit. The
  // refusal used no tokens: the thread gets one notice, the sign-in stays
  // connected, and the next message in the thread answers.
  openai.usageLimitRefusals = 1;
  expect(await sendMention("Ev_P74_LIMITED", P74_LIMITED_THREAD)).toBe(
    "case_accepted",
  );
  await expect
    .poll(threadAnswers.bind(null, slack.messages, P74_LIMITED_THREAD), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const limitNotice = threadAnswers(slack.messages, P74_LIMITED_THREAD);
  expect(openai.refusedRequests).toBe(1);
  expect(await readConnection()).toMatchObject({ kind: "connected" });
  expect(
    await sendReply(
      "Ev_P74_LIMITED_AGAIN",
      "1787501100.000002",
      P74_LIMITED_THREAD,
    ),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, P74_LIMITED_THREAD), {
      timeout: 30_000,
    })
    .toEqual([...limitNotice, "Two integrations answer here."]);

  // The next sign-in reuses the issued client and the host id.
  openai.accessTokenLifetimeSeconds = 120;
  await connectChatGptSignIn(openai, { reconnect: true });
  const secondAuthorize = authorizeParams(openai.authorizeRequests[1]);
  expect(secondAuthorize).toMatchObject({
    client_id: "oaiapp_e2e_1",
    ext_agent_host_id: firstAuthorize.ext_agent_host_id,
  });
  expect(secondAuthorize.agent_name_hint).toBeUndefined();
  expect(secondAuthorize.id_token_hint).toBeTruthy();

  // OpenAI refuses the refresh of that sign-in.
  openai.refuseRefresh = true;
  const modelRequestsBefore = openai.modelRequestCount();
  expect(await sendMention("Ev_P74_REFUSED", P74_REFUSED_THREAD)).toBe(
    "case_accepted",
  );
  await expect.poll(readConnection, { timeout: 30_000 }).toMatchObject({
    kind: "action_required",
    reason: "authorization_expired",
    signIn: "chatgpt_agent",
  });
  await expect
    .poll(threadAnswers.bind(null, slack.messages, P74_REFUSED_THREAD), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const refusalNotice = threadAnswers(slack.messages, P74_REFUSED_THREAD);
  // A second message finds no route: it reaches no model and repeats no
  // exchange.
  expect(
    await sendReply(
      "Ev_P74_REFUSED_AGAIN",
      "1787501000.000002",
      P74_REFUSED_THREAD,
    ),
  ).toBe("case_accepted");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(threadAnswers(slack.messages, P74_REFUSED_THREAD)).toEqual(
    refusalNotice,
  );
  expect(openai.refreshCount()).toBe(2);
  expect(openai.modelRequestCount()).toBe(modelRequestsBefore);
  const portal = await readPortalConnection();
  expect(portal).toMatchObject({
    ok: true,
    connection: {
      kind: "action_required",
      reason: "authorization_expired",
      signIn: "chatgpt_agent",
    },
  });
  // Every request to OpenAI left through the model exit Worker.
  expect(openai.directRequests).toEqual([]);

  Object.assign(test.task.meta, {
    plan74SignInSlack: {
      tokenRequests: openai.tokenRequests.map((request) => request.grant_type),
      authorize: [firstAuthorize, secondAuthorize].map((query) => ({
        client_id: query.client_id,
        agent_name_hint: query.agent_name_hint ?? null,
        id_token_hint: query.id_token_hint === undefined ? null : "present",
        host_id_reused:
          query.ext_agent_host_id === firstAuthorize.ext_agent_host_id,
      })),
      modelRequests: requests.map((request) => ({
        model: request.body.model,
        store: request.body.store,
        reasoning: request.body.reasoning,
        tools: offeredTools(request).length,
        toolOutput: lastToolOutput(request) !== null,
      })),
      answers: {
        first: threadAnswers(slack.messages, P74_FIRST_THREAD),
        second: threadAnswers(slack.messages, P74_SECOND_THREAD),
        refused: refusalNotice,
        usageLimit: threadAnswers(slack.messages, P74_LIMITED_THREAD),
      },
      afterRefusal: portal,
    },
  });
}

async function apiKeyRefusalSlackJourney(test: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const openai = new FakeOpenAiApi(ORGANISATION_OPENAI_KEY);
  openai.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  openai.answer = answerWithIntegrationList;
  await connectOpenAiApiKey(ORGANISATION_OPENAI_KEY);

  openai.rateLimitRefusals = 1;
  expect(await sendMention("Ev_KEY_LIMITED", KEY_LIMITED_THREAD)).toBe(
    "case_accepted",
  );
  await expect
    .poll(threadAnswers.bind(null, slack.messages, KEY_LIMITED_THREAD), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const limitNotice = threadAnswers(slack.messages, KEY_LIMITED_THREAD);
  expect(openai.refusedRequests).toBe(1);
  expect(openai.modelRequestCount()).toBe(0);
  expect(
    await sendReply(
      "Ev_KEY_LIMITED_AGAIN",
      "1787501200.000002",
      KEY_LIMITED_THREAD,
    ),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, KEY_LIMITED_THREAD), {
      timeout: 30_000,
    })
    .toEqual([...limitNotice, "Two integrations answer here."]);

  // The reply made two requests with the organisation's key: the tool call,
  // then the answer.
  const requests = [...openai.modelRequests];
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.headers.authorization).toBe(
      `Bearer ${ORGANISATION_OPENAI_KEY}`,
    );
    expect(request.body).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
    });
  }
  expect(lastToolOutput(requests[1]!)).toContain("integration_ref_");
  expect(openai.directRequests).toEqual([]);

  Object.assign(test.task.meta, {
    organisationKeyRefusalSlack: {
      refusedRequests: openai.refusedRequests,
      modelRequests: requests.map((request) => ({
        model: request.body.model,
        tools: offeredTools(request).length,
        toolOutput: lastToolOutput(request) !== null,
      })),
      answers: threadAnswers(slack.messages, KEY_LIMITED_THREAD),
    },
  });
}

/** The query of one authorize address that the person opened. */
function authorizeParams(url: URL | undefined): Record<string, string> {
  if (url === undefined) throw new Error("No authorize request");
  return Object.fromEntries(url.searchParams.entries());
}

async function weeklyRefreshJourney(test: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const chatgpt = new FakeChatGpt();
  chatgpt.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  chatgpt.answer = answerWithIntegrationList;
  await connectChatGptSubscription(chatgpt);

  // A sign-in from today needs no refresh.
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(chatgpt.refreshCount()).toBe(0);

  // Eight days later, with no turn in between, the cron refreshes it once.
  await ageSignIn(8);
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(chatgpt.refreshCount()).toBe(1);
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(chatgpt.refreshCount()).toBe(1);
  const refreshed = await readConnection();
  expect(refreshed).toMatchObject({ kind: "connected" });

  // A later sign-in is a week old and its access token expires within five
  // minutes. A Slack turn starts while the cron holds the refresh: the turn
  // waits for it, and OpenAI sees one refresh.
  chatgpt.accessTokenLifetimeSeconds = 120;
  await connectChatGptSubscription(chatgpt, { reconnect: true });
  await ageSignIn(8);
  chatgpt.accessTokenLifetimeSeconds = 3_600;
  const refreshAnswered = Promise.withResolvers<void>();
  chatgpt.refreshGate = refreshAnswered.promise;
  const weekly = runWeeklyChatGptLoginRefresh(env, Date.now());
  await expect
    .poll(chatgpt.refreshCount.bind(chatgpt), { timeout: 15_000 })
    .toBe(2);
  expect(await sendMention("Ev_P72_WEEKLY", WEEKLY_THREAD)).toBe(
    "case_accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(chatgpt.modelRequestCount()).toBe(0);
  refreshAnswered.resolve();
  await weekly;
  await expect
    .poll(threadAnswers.bind(null, slack.messages, WEEKLY_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  expect(chatgpt.refreshCount()).toBe(2);
  for (const request of chatgpt.modelRequests)
    expect(chatgpt.accepts(request.headers.authorization)).toBe(true);

  // OpenAI refuses the next weekly refresh: Portal asks for a new sign-in.
  await ageSignIn(8);
  chatgpt.refuseRefresh = true;
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(chatgpt.refreshCount()).toBe(3);
  const portal = await readPortalConnection();
  expect(portal).toMatchObject({
    ok: true,
    connection: { kind: "action_required", reason: "authorization_expired" },
  });

  Object.assign(test.task.meta, {
    plan72WeeklyRefresh: {
      refreshes: chatgpt.refreshCount(),
      afterFirstWeek: refreshed,
      weeklyThread: threadAnswers(slack.messages, WEEKLY_THREAD),
      modelRequests: chatgpt.modelRequestCount(),
      afterRefusal: portal,
    },
  });
}

/**
 * The model exit Worker refuses a host outside its list, also one whose name
 * starts with an allowed host, and no request leaves it.
 */
async function sendOutsideModelExitHosts(): Promise<unknown[]> {
  const reached: string[] = [];
  network.use(
    http.all("https://example.com/*", recordOutsideRequest.bind(null, reached)),
    http.all(
      "https://chatgpt.com.attacker.test/*",
      recordOutsideRequest.bind(null, reached),
    ),
    http.all(
      "https://chatgpt.com/auth/*",
      recordOutsideRequest.bind(null, reached),
    ),
  );
  const refusals: unknown[] = [];
  for (const url of [
    "https://example.com/v1/responses",
    "https://chatgpt.com.attacker.test/backend-api/codex/responses",
    // chatgpt.com blocks Workers; only the ChatGPT exit sends to it.
    "https://chatgpt.com/backend-api/codex/responses",
  ]) {
    const refused = await env.MODEL_EXIT.fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer must-not-leave" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-satyr-exit-colo")).toBeTruthy();
    refusals.push({ url, status: refused.status, body: await refused.json() });
  }
  for (const url of [
    "https://chatgpt.com.attacker.test/backend-api/codex/responses",
    "https://api.openai.com/v1/responses",
    "https://chatgpt.com/auth/session",
  ]) {
    const refused = await env.CHATGPT_EXIT.fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer must-not-leave" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    refusals.push({ url, status: refused.status, body: await refused.json() });
  }
  expect(refusals).toMatchObject([
    { body: { error: "model_exit_host_refused" } },
    { body: { error: "model_exit_host_refused" } },
    { body: { error: "model_exit_host_refused" } },
    { body: { error: "chatgpt_exit_host_refused" } },
    { body: { error: "chatgpt_exit_host_refused" } },
    { body: { error: "chatgpt_exit_host_refused" } },
  ]);
  expect(reached).toEqual([]);
  return refusals;
}

function recordOutsideRequest(
  reached: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Response {
  reached.push(request.url);
  return HttpResponse.json({ reached: true });
}

/** Move the last sign-in or refresh of the connection this many days back. */
async function ageSignIn(days: number): Promise<void> {
  await fixtureDatabase()
    .prepare(
      `UPDATE organisation_codex_connection
     SET verified_at = verified_at - ? WHERE organisation_id = ?`,
    )
    .bind(days * DAY_MS, ORGANISATION_ID)
    .run();
}

/** Each thread asks for the integration list once, then answers. */
function answerWithIntegrationList(
  request: ChatGptModelRequest,
): ChatGptAnswer {
  if (lastToolOutput(request) !== null)
    return textAnswer("Two integrations answer here.");
  return {
    kind: "tool_call",
    name: "integration_list",
    arguments: {},
    callId: `call_${promptCacheKey(request).slice(-12)}`,
  };
}

function promptCacheKey(request: ChatGptModelRequest): string {
  const key = request.body.prompt_cache_key;
  if (typeof key !== "string") throw new Error("Missing prompt cache key");
  return key;
}

function isText(value: string | null): value is string {
  return value !== null;
}

function threadAnswers(
  messages: readonly Record<string, string>[],
  threadTs: string,
): string[] {
  return messages
    .filter(
      (message) =>
        message.channel === CHANNEL_ID && message.thread_ts === threadTs,
    )
    .map(readSlackMessageText);
}

async function readConnection(): Promise<unknown> {
  const read = await readOrganisationCodexConnection({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
    reconcile: false,
  });
  return read.ok ? read.value : read.error;
}

async function readPortalConnection(): Promise<unknown> {
  const session = await issueControlSession({
    db: env.DB,
    userId: fixtureUser(),
    now: Date.now(),
    ttlMs: 600_000,
  });
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/inference/codex`,
    {
      headers: {
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
      },
    },
  );
  return response.json();
}

function sendMention(eventId: string, threadTs: string): Promise<unknown> {
  return sendSlack(eventId, threadTs, threadTs, "app_mention");
}

function sendReply(
  eventId: string,
  messageTs: string,
  threadTs: string,
): Promise<unknown> {
  return sendSlack(eventId, messageTs, threadTs, "message");
}

async function sendSlack(
  eventId: string,
  messageTs: string,
  threadTs: string,
  eventType: "app_mention" | "message",
): Promise<unknown> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType,
        eventId,
        messageTs,
        threadTs,
        text:
          eventType === "app_mention"
            ? "<@U0SATYR> Which integrations are connected?"
            : "Try again, please.",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return isRecord(body) ? body.durableMode : null;
}
