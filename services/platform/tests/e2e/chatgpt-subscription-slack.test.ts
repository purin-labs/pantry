import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import {
  readOrganisationCodexConnection,
  runWeeklyChatGptLoginRefresh,
} from "../../src/models/codex-connection";
import { issueControlSession } from "../../src/data/control-plane";
import {
  FakeOpenAiApi,
  FakeOpenAiSignIn,
  connectChatGptSignIn,
  connectOpenAiApiKey,
  fixtureUser,
  lastToolOutput,
  offeredTools,
  sendMention,
  sendReply,
  textAnswer,
  type ChatGptAnswer,
  type ChatGptModelRequest,
} from "./chatgpt-subscription-support";
import { network } from "./network";
import { archiveAsOwner } from "./purge-support";
import {
  ORGANISATION_ID,
  installDiscoveryActorFixture,
  slackSimulator,
  threadAnswers,
} from "./slack-journey-support";

/**
 * Plan 72: a "Sign in with ChatGPT" sign-in that no turn uses still
 * refreshes every week. The 15-minute cron refreshes a sign-in whose last
 * refresh is older than seven days one time, and leaves a newer one alone. A Slack turn that needs a
 * token while that refresh runs waits for it, and OpenAI sees one refresh.
 * When OpenAI refuses the weekly refresh, Portal asks for a new sign-in.
 * After the owner archives the Organisation, its sign-in stays until the
 * purge, and the cron does not refresh it.
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
 *
 * Plan 73: the fake OpenAI refuses each request that does not leave through
 * the model exit Worker, as OpenAI refuses a request from Hong Kong. The
 * model exit Worker refuses a host outside its list and sends nothing.
 * Plan 75: the ChatGPT exit refuses the hosts of the model exit, and the
 * model exit refuses chatgpt.com, which blocks requests from a Worker.
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

const WEEKLY_THREAD = "1787500700.000001";
const DAY_MS = 24 * 60 * 60 * 1_000;
const P74_FIRST_THREAD = "1787500800.000001";
const P74_SECOND_THREAD = "1787500900.000001";
const P74_REFUSED_THREAD = "1787501000.000001";
const P74_LIMITED_THREAD = "1787501100.000001";
const KEY_LIMITED_THREAD = "1787501200.000001";
const ORGANISATION_OPENAI_KEY = "sk-proj-e2e-organisation-openai-key-0001";

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
    agent_name_hint: "Purin Sous Chef",
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
  // Every request to OpenAI left through the model exit Worker, and each
  // exit refuses a host outside its list.
  expect(openai.directRequests).toEqual([]);
  const exitRefusals = await sendOutsideModelExitHosts();

  Object.assign(test.task.meta, {
    plan73ModelExit: { exitRefusals },
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
  const fixture = await installDiscoveryActorFixture();
  const openai = new FakeOpenAiSignIn();
  openai.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  openai.answer = answerWithIntegrationList;
  await connectChatGptSignIn(openai);

  // A sign-in from today needs no refresh.
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(openai.refreshCount()).toBe(0);

  // Eight days later, with no turn in between, the cron refreshes it once.
  await ageSignIn(8);
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(openai.refreshCount()).toBe(1);
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(openai.refreshCount()).toBe(1);
  const refreshed = await readConnection();
  expect(refreshed).toMatchObject({
    kind: "connected",
    signIn: "chatgpt_agent",
  });

  // A later sign-in is a week old and its access token expires within five
  // minutes. A Slack turn starts while the cron holds the refresh: the turn
  // waits for it, and OpenAI sees one refresh.
  openai.accessTokenLifetimeSeconds = 120;
  await connectChatGptSignIn(openai, { reconnect: true });
  await ageSignIn(8);
  openai.accessTokenLifetimeSeconds = 3_600;
  const refreshAnswered = Promise.withResolvers<void>();
  openai.refreshGate = refreshAnswered.promise;
  const weekly = runWeeklyChatGptLoginRefresh(env, Date.now());
  await expect
    .poll(openai.refreshCount.bind(openai), { timeout: 15_000 })
    .toBe(2);
  expect(await sendMention("Ev_P72_WEEKLY", WEEKLY_THREAD)).toBe(
    "case_accepted",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(openai.modelRequestCount()).toBe(0);
  refreshAnswered.resolve();
  await weekly;
  await expect
    .poll(threadAnswers.bind(null, slack.messages, WEEKLY_THREAD), {
      timeout: 30_000,
    })
    .toEqual(["Two integrations answer here."]);
  expect(openai.refreshCount()).toBe(2);
  for (const request of openai.modelRequests)
    expect(openai.accepts(request.headers.authorization)).toBe(true);

  // OpenAI refuses the next weekly refresh: Portal asks for a new sign-in.
  await ageSignIn(8);
  openai.refuseRefresh = true;
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(openai.refreshCount()).toBe(3);
  const portal = await readPortalConnection();
  expect(portal).toMatchObject({
    ok: true,
    connection: { kind: "action_required", reason: "authorization_expired" },
  });

  // The owner signs in again and then archives the Organisation. The sign-in
  // stays for the 30 days before the purge, but OpenAI sees no refresh for
  // an Organisation that its owner archived.
  openai.refuseRefresh = false;
  await connectChatGptSignIn(openai, { reconnect: true });
  await ageSignIn(8);
  await archiveAsOwner({
    organisationId: ORGANISATION_ID,
    userId: fixture.ownerSession.session.userId,
  });
  const beforeArchivedCron = await readConnection();
  await runWeeklyChatGptLoginRefresh(env, Date.now());
  expect(openai.refreshCount()).toBe(3);
  const afterArchivedCron = await readConnection();
  expect(afterArchivedCron).toEqual(beforeArchivedCron);

  Object.assign(test.task.meta, {
    plan72WeeklyRefresh: {
      refreshes: openai.refreshCount(),
      afterFirstWeek: refreshed,
      weeklyThread: threadAnswers(slack.messages, WEEKLY_THREAD),
      modelRequests: openai.modelRequestCount(),
      afterRefusal: portal,
      afterArchivedCron,
    },
  });
}

/**
 * The model exit Worker and the ChatGPT exit each refuse a host outside
 * their list, also one whose name starts with an allowed host, and no
 * request leaves them.
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
    expect(refused.headers.get("x-pantry-exit-colo")).toBeTruthy();
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
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      },
    },
  );
  return response.json();
}
