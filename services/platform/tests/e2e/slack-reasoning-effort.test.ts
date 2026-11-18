import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  parseAnthropicApiKey,
  storeOrganisationAnthropicModelCredential,
} from "../../src/credential-vault";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { preparePortalChatJourney } from "./chat-journey-support";
import { selectInference } from "./chatgpt-subscription-support";
import { MODEL_EXIT_EGRESS_HEADER } from "./model-exit-network";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  readSlackMessageText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * Slack answers run on the reasoning effort that an owner or admin picks in
 * Portal. With no choice, a Slack answer on Claude uses the source's own
 * level, high. An operator cannot change the level. After an admin picks
 * "Fast", the next answer in a thread that is already open reaches Anthropic
 * at low effort. After the admin returns to "Standard", a new thread is at
 * high again.
 */
it(
  "answers Slack at the reasoning effort that an admin picks in Portal, also in an open thread",
  slackReasoningEffortJourney,
  120_000,
);

const ANTHROPIC_KEY = "sk-ant-api03-e2e-slack-reasoning-effort-0001";
const FIRST_THREAD = "1787502100.000001";
const FIRST_THREAD_REPLY = "1787502100.000002";
const SECOND_THREAD = "1787502200.000001";
const ANSWER = "The croissant dough is proofing.";

async function slackReasoningEffortJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const anthropic = new FakeAnthropic(ANTHROPIC_KEY);
  anthropic.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  // The chat fixture starts on the Pantry-funded OpenRouter route.
  await connectAnthropicApiKey(ANTHROPIC_KEY);

  expect(await readEffort(session)).toEqual({ status: 200, effort: null });
  expect(
    await sendSlack("Ev_EFFORT_STANDARD", FIRST_THREAD, FIRST_THREAD),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, FIRST_THREAD), {
      timeout: 30_000,
    })
    .toEqual([ANSWER]);
  expect(anthropic.requests.map(turnEffort)).toEqual(["high"]);

  // An operator may read the level but not change it. Like every control
  // route, the refusal does not say that the route exists.
  await setRole("operator");
  const refused = await writeEffort(session, "low");
  expect(refused.status).toBe(404);
  expect(await readEffort(session)).toEqual({ status: 200, effort: null });
  await setRole("admin");

  const chosen = await writeEffort(session, "low");
  expect(chosen).toMatchObject({ status: 200, body: { effort: "low" } });
  expect(await readEffort(session)).toEqual({ status: 200, effort: "low" });

  // The thread is open. Its next answer takes the new level.
  expect(
    await sendSlack("Ev_EFFORT_FAST", FIRST_THREAD_REPLY, FIRST_THREAD),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, FIRST_THREAD), {
      timeout: 30_000,
    })
    .toEqual([ANSWER, ANSWER]);
  expect(anthropic.requests.map(turnEffort)).toEqual(["high", "low"]);

  const standard = await writeEffort(session, null);
  expect(standard).toMatchObject({ status: 200, body: { effort: null } });
  expect(
    await sendSlack("Ev_EFFORT_STANDARD_AGAIN", SECOND_THREAD, SECOND_THREAD),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, SECOND_THREAD), {
      timeout: 30_000,
    })
    .toEqual([ANSWER]);
  expect(anthropic.requests.map(turnEffort)).toEqual(["high", "low", "high"]);

  Object.assign(test.task.meta, {
    slackReasoningEffort: {
      operatorWrite: refused,
      adminWrites: [chosen.body, standard.body],
      providerRequests: anthropic.requests.map(requestSummary),
      firstThread: threadAnswers(slack.messages, FIRST_THREAD),
      secondThread: threadAnswers(slack.messages, SECOND_THREAD),
    },
  });
}

/** The effort of the turn: the last effort marker that Pi sends. */
function turnEffort(body: Record<string, unknown>): unknown {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const marker: unknown = messages.findLast(
    (message: unknown) =>
      isRecord(message) &&
      message.role === "system" &&
      isRecord(message.output_config),
  );
  return isRecord(marker) && isRecord(marker.output_config)
    ? marker.output_config.effort
    : null;
}

function requestSummary(body: Record<string, unknown>): unknown {
  return { model: body.model, effort: turnEffort(body) };
}

async function readEffort(
  session: IssuedControlSession,
): Promise<{ readonly status: number; readonly effort: unknown }> {
  const response = await exports.default.fetch(effortUrl(), {
    headers: headers(session),
  });
  const body: unknown = await response.json();
  return {
    status: response.status,
    effort: isRecord(body) ? body.effort : undefined,
  };
}

async function writeEffort(
  session: IssuedControlSession,
  effort: "low" | "medium" | "high" | null,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const request = headers(session);
  request.set("idempotency-key", `e2e-slack-effort-${crypto.randomUUID()}`);
  const response = await exports.default.fetch(effortUrl(), {
    method: "PUT",
    headers: request,
    body: JSON.stringify({ effort }),
  });
  return { status: response.status, body: await response.json() };
}

function effortUrl(): string {
  return `https://localhost/v1/control/organisations/${ORGANISATION_ID}/inference/slack-reasoning-effort`;
}

function headers(session: IssuedControlSession): Headers {
  return new Headers({
    origin: "https://localhost",
    "content-type": "application/json",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  });
}

/** The role of the person behind both the control session and Slack. */
async function setRole(role: "admin" | "operator"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(role, ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .run();
}

/**
 * Store the organisation's own Anthropic API key, as an owner does in
 * Portal, and make it the inference route.
 */
async function connectAnthropicApiKey(apiKey: string): Promise<void> {
  const key = parseAnthropicApiKey(apiKey);
  if (!key.ok) throw new Error(key.error.code);
  const stored = await storeOrganisationAnthropicModelCredential({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    apiKey: key.value,
    now: Date.now(),
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await selectInference({ kind: "organisation_anthropic_api_key" });
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

async function sendSlack(
  eventId: string,
  messageTs: string,
  threadTs: string,
): Promise<unknown> {
  const mention = messageTs === threadTs;
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: mention ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs,
        text: mention ? "<@U0SATYR> How is the croissant dough?" : "And now?",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return isRecord(body) ? body.durableMode : null;
}

/**
 * A fake Anthropic Messages API for the organisation's own API key. It only
 * records each request and answers it with one text. Like Anthropic, it
 * refuses a key that it did not issue, and each request that did not leave
 * through the model exit Worker.
 */
class FakeAnthropic {
  readonly requests: Record<string, unknown>[] = [];

  constructor(readonly apiKey: string) {}

  install(): void {
    network.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        this.respond.bind(this),
      ),
    );
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (!request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return anthropicError(403, "forbidden", "Request not allowed");
    if (request.headers.get("x-api-key") !== this.apiKey)
      return anthropicError(401, "authentication_error", "invalid x-api-key");
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Messages request body is invalid");
    const id = `msg_e2e_slack_effort_${String(this.requests.push(body))}`;
    const events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ANSWER },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
      { type: "message_stop" },
    ];
    return new HttpResponse(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
}

function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  return HttpResponse.json(
    { type: "error", error: { type, message } },
    { status },
  );
}
