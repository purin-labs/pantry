import { exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  chat,
  preparePortalChatJourney,
  readWork,
} from "./chat-journey-support";
import {
  FakeOpenAiSignIn,
  selectInference,
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
