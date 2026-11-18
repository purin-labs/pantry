import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  readOrganisationCodexConnection,
  startOrganisationCodexAuthorization,
} from "../../src/models/codex-connection";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  chat,
  preparePortalChatJourney,
  readWork,
} from "./chat-journey-support";
import {
  FakeChatGpt,
  FakeOpenAiSignIn,
  fixtureUser,
  selectInference,
  signInToChatGpt,
  textAnswer,
} from "./chatgpt-subscription-support";
import {
  ORGANISATION_ID,
  slackActorFixtureOwner,
} from "./slack-journey-support";

/**
 * Plan 74B: an owner signs in with ChatGPT in Portal. OpenAI sends the
 * browser to a loopback page that does not load, and the owner pastes its
 * address. An address of another sign-in is refused and the sign-in stays
 * open; the right one connects, and OpenAI sees one code exchange. A Portal
 * chat turn then runs on Pi through api.openai.com. Portal says plainly
 * that OpenAI reports no allowance, and its polls send no request to OpenAI.
 */
it(
  "signs in with ChatGPT by a pasted address in Portal and answers a chat turn on api.openai.com",
  portalSignInJourney,
  120_000,
);

/**
 * Plan 72: a connection with the Codex sign-in, which stays until a
 * production turn passes on the Plan 74B route. A Portal chat turn runs on
 * Pi through chatgpt.com, and Portal shows the allowance that the backend
 * reported with that turn. When the backend refuses a request at the usage
 * limit, the connection pauses with `allowance_exhausted`.
 */
it(
  "answers a Portal chat turn on Pi through the Codex sign-in and shows its allowance",
  portalSubscriptionJourney,
  120_000,
);

/**
 * Plan 74B: chatgpt.com refuses each allowance read with a challenge page, as
 * it refused each read from the exit Worker on 2026-10-19. A failed read
 * still uses its five-minute interval. So Portal, which polls the connection
 * from several tabs, sends at most one read to chatgpt.com in each interval
 * and shows the last allowance that it knows.
 */
it(
  "reads the ChatGPT allowance at most once in each interval while chatgpt.com refuses it",
  refusedAllowanceJourney,
  120_000,
);

const ALLOWANCE_READ_INTERVAL_MS = 5 * 60 * 1_000;

async function portalSubscriptionJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const owner = await slackActorFixtureOwner();
  const chatgpt = new FakeChatGpt();
  chatgpt.install();

  await signInToChatGpt(chatgpt, {
    organisationId: ORGANISATION_ID,
    userId: fixtureUser(),
    reconnect: false,
  });
  const connected = await control(owner.session, "GET", "inference/codex");
  expect(connected).toMatchObject({
    status: 200,
    body: {
      connection: {
        kind: "connected",
        revision: 1,
        signIn: "codex_device",
        planType: "pro",
        allowance: { kind: "available", usedPercent: 25, credits: "available" },
      },
    },
  });
  // The sign-in exchanged the device's authorization code exactly once.
  expect(chatgpt.tokenRequests.map(grantType)).toEqual(["authorization_code"]);

  await selectInference({ kind: "codex_subscription" });
  chatgpt.usedPercent = 42;
  chatgpt.answer = () =>
    textAnswer(JSON.stringify({ kind: "reply", text: "Stock review ready." }));
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 30_000 })
    .toBe("ready");
  expect(await (await chat(session, null)).text()).toContain(
    "Stock review ready.",
  );
  expect(chatgpt.modelRequests).toHaveLength(1);
  const request = chatgpt.modelRequests[0];
  expect(chatgpt.accepts(request?.headers.authorization)).toBe(true);
  expect(request?.headers.originator).toBe("pi");
  expect(request?.body.model).toBe("gpt-5.6-luna");

  // Portal shows what the turn's response reported, without a usage read.
  const afterTurn = await control(session, "GET", "inference/codex");
  expect(afterTurn).toMatchObject({
    status: 200,
    body: {
      connection: {
        kind: "connected",
        allowance: { kind: "available", usedPercent: 42 },
      },
    },
  });
  expect(chatgpt.usageReads).toHaveLength(1);

  // The backend refuses the next request at the usage limit.
  chatgpt.usedPercent = 100;
  chatgpt.limitReached = true;
  chatgpt.hasCredits = false;
  expect((await chat(session, 2)).status).toBe(200);
  await expect
    .poll(readConnectionBody.bind(null, owner.session), { timeout: 30_000 })
    .toMatchObject({
      connection: {
        kind: "action_required",
        reason: "allowance_exhausted",
        allowance: { usedPercent: 100, credits: "exhausted" },
      },
    });
  const exhausted = await control(owner.session, "GET", "inference/codex");
  await expect
    .poll(readWork.bind(null, session), { timeout: 30_000 })
    .toBe("failed");
  expect(chatgpt.modelRequests).toHaveLength(2);
  expect(chatgpt.refreshCount()).toBe(0);

  Object.assign(test.task.meta, {
    plan72SubscriptionPortal: {
      connected: connected.body,
      afterTurn: afterTurn.body,
      exhausted: exhausted.body,
      tokenRequests: chatgpt.tokenRequests.map(grantType),
      modelRequests: chatgpt.modelRequests.length,
      usageReads: chatgpt.usageReads.length,
    },
  });
}

async function portalSignInJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const owner = await slackActorFixtureOwner();
  const openai = new FakeOpenAiSignIn();
  openai.install();

  const started = await control(
    owner.session,
    "POST",
    "inference/codex/authorizations",
  );
  expect(started).toMatchObject({
    status: 200,
    body: {
      ok: true,
      connection: {
        kind: "authorizing",
        attempt: { method: "pasted_callback", userCode: null },
      },
    },
  });
  const attempt = authorizingAttempt(started.body);
  const authorize = new URL(attempt.verificationUrl);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(
    "https://auth.openai.com/api/accounts/authorize",
  );
  expect(Object.fromEntries(authorize.searchParams.entries())).toMatchObject({
    client_id: "dynamic_agent_client",
    agent_name_hint: "Seams Sous Chef",
    redirect_uri: "http://127.0.0.1:1455/auth/callback",
    resource: "https://api.openai.com/v1",
    code_challenge_method: "S256",
  });
  // Portal polls while the owner is at OpenAI; nothing goes to OpenAI.
  for (let poll = 0; poll < 3; poll += 1)
    expect(
      await control(owner.session, "GET", "inference/codex"),
    ).toMatchObject({
      status: 200,
      body: { connection: { kind: "authorizing" } },
    });
  expect(openai.tokenRequests).toEqual([]);

  // The owner allows Pantry. The browser shows the loopback address.
  const address = openai.approve(attempt.verificationUrl);
  const complete = `inference/codex/authorizations/${attempt.attemptId}/complete`;
  const otherState = new URL(address);
  otherState.searchParams.set("state", "another-sign-in");
  const refused = await control(owner.session, "POST", complete, {
    callbackUrl: otherState.toString(),
  });
  expect(refused).toMatchObject({
    status: 422,
    body: { error: "codex_sign_in_address_invalid" },
  });
  expect(await control(owner.session, "GET", "inference/codex")).toMatchObject({
    body: { connection: { kind: "authorizing" } },
  });

  const connected = await control(owner.session, "POST", complete, {
    callbackUrl: `  ${address}\n`,
  });
  expect(connected).toMatchObject({
    status: 200,
    body: {
      ok: true,
      connection: {
        kind: "connected",
        signIn: "chatgpt_agent",
        planType: "plus",
        allowance: { kind: "not_reported" },
      },
    },
  });
  expect(openai.tokenRequests.map(grantType)).toEqual(["authorization_code"]);
  // A second paste of the same address finds no open sign-in.
  expect(
    await control(owner.session, "POST", complete, { callbackUrl: address }),
  ).toMatchObject({
    status: 404,
    body: { error: "codex_authorization_not_found" },
  });
  expect(openai.tokenRequests).toHaveLength(1);

  await selectInference({ kind: "codex_subscription" });
  openai.answer = () =>
    textAnswer(JSON.stringify({ kind: "reply", text: "Stock review ready." }));
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 30_000 })
    .toBe("ready");
  expect(await (await chat(session, null)).text()).toContain(
    "Stock review ready.",
  );
  expect(openai.modelRequests).toHaveLength(1);
  const request = openai.modelRequests[0];
  expect(openai.accepts(request?.headers.authorization)).toBe(true);
  expect(request?.body).toMatchObject({
    model: "gpt-5.6-luna",
    store: false,
    stream: true,
  });

  // Portal polls the connection after the turn: OpenAI reports no
  // allowance, so the polls send nothing to OpenAI.
  const afterTurn: unknown[] = [];
  for (let poll = 0; poll < 3; poll += 1)
    afterTurn.push(await control(session, "GET", "inference/codex"));
  for (const poll of afterTurn)
    expect(poll).toMatchObject({
      status: 200,
      body: {
        connection: {
          kind: "connected",
          signIn: "chatgpt_agent",
          allowance: { kind: "not_reported" },
        },
      },
    });
  expect(openai.tokenRequests).toHaveLength(1);
  expect(openai.modelRequests).toHaveLength(1);
  expect(openai.directRequests).toEqual([]);

  Object.assign(test.task.meta, {
    plan74SignInPortal: {
      authorizing: started.body,
      wrongAddress: refused.body,
      connected: connected.body,
      afterTurn: afterTurn.at(-1),
      tokenRequests: openai.tokenRequests.map(grantType),
      modelRequests: openai.modelRequests.length,
    },
  });
}

function authorizingAttempt(body: unknown): {
  readonly attemptId: string;
  readonly verificationUrl: string;
} {
  const attempt =
    isRecord(body) && isRecord(body.connection)
      ? body.connection.attempt
      : undefined;
  if (
    !isRecord(attempt) ||
    typeof attempt.attemptId !== "string" ||
    typeof attempt.verificationUrl !== "string"
  )
    throw new Error("No open ChatGPT sign-in");
  return {
    attemptId: attempt.attemptId,
    verificationUrl: attempt.verificationUrl,
  };
}

async function refusedAllowanceJourney(test: TestContext): Promise<void> {
  await preparePortalChatJourney();
  const owner = await slackActorFixtureOwner();
  const chatgpt = new FakeChatGpt();
  chatgpt.install();

  // The owner signed in six minutes ago, so the allowance read is due.
  const signedInAt = Date.now() - ALLOWANCE_READ_INTERVAL_MS - 60_000;
  const started = await startOrganisationCodexAuthorization({
    env,
    organisationId: ORGANISATION_ID,
    userId: fixtureUser(),
    now: signedInAt,
    reconnect: false,
    signIn: "codex_device",
  });
  expect(started.ok).toBe(true);
  chatgpt.approve();
  expect(await readConnectionAt(signedInAt)).toMatchObject({
    kind: "connected",
    allowance: { kind: "available", usedPercent: 25 },
  });
  expect(chatgpt.usageReads).toHaveLength(1);
  chatgpt.challengeUsageReads = true;

  // Three Portal tabs poll at the same time, then one tab polls on.
  const burst = await Promise.all(
    [1, 2, 3].map(() => control(owner.session, "GET", "inference/codex")),
  );
  const polls = [...burst];
  for (let poll = 0; poll < 20; poll += 1)
    polls.push(await control(owner.session, "GET", "inference/codex"));
  for (const poll of polls)
    expect(poll).toMatchObject({
      status: 200,
      body: {
        connection: {
          kind: "connected",
          allowance: { kind: "available", usedPercent: 25 },
        },
      },
    });
  expect(chatgpt.usageReads).toHaveLength(2);

  // Portal polls every ten seconds for the next sixteen minutes, from three
  // tabs. The route reads the connection with the time of each request.
  const firstRefusedRead = Date.now();
  const readTimes: number[] = [];
  for (let step = 1; step <= 96; step += 1) {
    const now = firstRefusedRead + step * 10_000;
    const before = chatgpt.usageReads.length;
    const answers = await Promise.all([
      readConnectionAt(now),
      readConnectionAt(now),
      readConnectionAt(now),
    ]);
    for (const answer of answers)
      expect(answer).toMatchObject({ kind: "connected" });
    for (let read = before; read < chatgpt.usageReads.length; read += 1)
      readTimes.push(now);
  }
  // One refused read in each five-minute interval: at 5, 10 and 15 minutes.
  expect(readTimes.map((at) => at - firstRefusedRead)).toEqual([
    ALLOWANCE_READ_INTERVAL_MS,
    2 * ALLOWANCE_READ_INTERVAL_MS,
    3 * ALLOWANCE_READ_INTERVAL_MS,
  ]);
  expect(chatgpt.usageReads).toHaveLength(5);
  expect(chatgpt.directRequests).toEqual([]);

  Object.assign(test.task.meta, {
    plan74RefusedAllowanceReads: {
      portalPolls: polls.length + 96 * 3,
      refusedReads: chatgpt.usageReads.length - 1,
      readOffsetsMs: readTimes.map((at) => at - firstRefusedRead),
    },
  });
}

async function readConnectionAt(now: number): Promise<unknown> {
  const connection = await readOrganisationCodexConnection({
    env,
    organisationId: ORGANISATION_ID,
    now,
    reconcile: true,
  });
  if (!connection.ok) throw new Error(connection.error.code);
  return connection.value;
}

async function readConnectionBody(
  session: IssuedControlSession,
): Promise<unknown> {
  return (await control(session, "GET", "inference/codex")).body;
}

function grantType(request: Readonly<Record<string, string>>): string {
  return request.grant_type ?? "";
}

async function control(
  session: IssuedControlSession,
  method: "GET" | "POST",
  path: string,
  json: Readonly<Record<string, unknown>> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/${path}`,
    {
      method,
      headers: {
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(json) : undefined,
    },
  );
  const body: unknown = await response.json();
  return { status: response.status, body: isRecord(body) ? body : null };
}
