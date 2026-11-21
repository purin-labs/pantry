import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  handleSlackIngress,
  type SlackIngressEnv,
} from "../../src/slack-ingress/handler";
import { commerceClient } from "./commerce-support";
import {
  ORGANISATION_ID,
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  WORKSPACE_ID,
  hex,
  installSlackActorFixture,
} from "./slack-journey-support";

/** A second member of the Slack actor fixture, with a linked Slack account. */
export const PEER_SLACK_USER_ID = "U0E2EPEER";
const PEER_PERSON_ID = "person_e2e-side-case-peer";

/** One call that Pantry made to Slack, as the fake recorded it. */
export type SlackCall = Readonly<{
  method: "chat.postMessage" | "chat.update" | "chat.startStream";
  channel: string;
  /** Absent for a new top-level message. */
  threadTs: string | null;
  /** The message's own timestamp. */
  ts: string;
  text: string;
  blocks: readonly Record<string, unknown>[];
}>;

/**
 * The fake Slack of a side Case journey. It answers every call that Pantry
 * makes and records each post, change and stream. A streamed answer is one
 * message: its text is the text of its parts. It also records what Pantry
 * tells one person through an interaction's response URL.
 */
export function sideCaseSlack(): {
  readonly handlers: readonly ReturnType<typeof http.post>[];
  readonly calls: SlackCall[];
  readonly ephemeral: string[];
  readonly posts: () => SlackCall[];
} {
  const calls: SlackCall[] = [];
  const ephemeral: string[] = [];
  let next = 0;
  return {
    calls,
    ephemeral,
    posts: function posts(): SlackCall[] {
      return calls.filter(isPostOrStream);
    },
    handlers: [
      http.get(
        "https://slack.com/api/chat.getPermalink",
        function permalink({ request }) {
          requireBotToken(request);
          const query = new URL(request.url).searchParams;
          const channel = query.get("channel") ?? "";
          const ts = query.get("message_ts") ?? "";
          return HttpResponse.json({
            ok: true,
            channel,
            permalink: slackPermalink(channel, ts),
          });
        },
      ),
      http.post(
        "https://slack.com/api/:method",
        async function respond({ params, request }) {
          requireBotToken(request);
          const method = String(params.method);
          const body: unknown = await request.json();
          if (method === "assistant.threads.setStatus")
            return HttpResponse.json({ ok: true });
          if (!isRecord(body) || typeof body.channel !== "string")
            throw new Error(`Slack ${method} body is invalid`);
          if (method === "chat.update") {
            const ts = String(body.ts);
            const index = calls.findIndex((call) => call.ts === ts);
            if (index < 0)
              return HttpResponse.json({
                ok: false,
                error: "message_not_found",
              });
            calls.push({
              ...shown(body),
              method: "chat.update",
              channel: body.channel,
              threadTs: calls[index]?.threadTs ?? null,
              ts,
            });
            return HttpResponse.json({ ok: true, channel: body.channel, ts });
          }
          if (method === "chat.appendStream" || method === "chat.stopStream") {
            const stream = calls.find((call) => call.ts === body.ts);
            if (stream === undefined)
              return HttpResponse.json({
                ok: false,
                error: "message_not_found",
              });
            const index = calls.indexOf(stream);
            calls[index] = { ...stream, text: stream.text + shown(body).text };
            return HttpResponse.json({ ok: true, ts: stream.ts });
          }
          if (method !== "chat.postMessage" && method !== "chat.startStream")
            throw new Error(`Unexpected Slack method: ${method}`);
          next += 1;
          const ts = `1787500200.${String(next).padStart(6, "0")}`;
          calls.push({
            ...shown(body),
            method,
            channel: body.channel,
            threadTs:
              typeof body.thread_ts === "string" ? body.thread_ts : null,
            ts,
          });
          return HttpResponse.json({ ok: true, channel: body.channel, ts });
        },
      ),
      http.post(
        "https://hooks.slack.com/actions/:team/:id/:token",
        async function respondToClick({ request }) {
          const body: unknown = await request.json();
          if (!isRecord(body) || body.response_type !== "ephemeral")
            throw new Error("Pantry answered a click for everyone");
          ephemeral.push(String(body.text));
          return HttpResponse.text("ok");
        },
      ),
    ],
  };
}

export function slackPermalink(channel: string, ts: string): string {
  return `https://e2e-pantry.slack.test/archives/${channel}/p${ts.replace(".", "")}`;
}

function isPostOrStream(call: SlackCall): boolean {
  return call.method !== "chat.update";
}

function requireBotToken(request: { readonly headers: Headers }): void {
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${SLACK_BOT_TOKEN}`,
  );
}

/** The text and blocks of a post, as Slack shows them. */
function shown(
  body: Record<string, unknown>,
): Pick<SlackCall, "text" | "blocks"> {
  const text =
    typeof body.markdown_text === "string"
      ? body.markdown_text
      : typeof body.text === "string"
        ? body.text
        : "";
  return {
    text,
    blocks: Array.isArray(body.blocks) ? body.blocks.filter(isRecord) : [],
  };
}

/** Every text of a message: its blocks, or its text when it has none. */
export function shownText(call: SlackCall): string {
  return call.blocks.length === 0 ? call.text : JSON.stringify(call.blocks);
}

/** The proposal id of the Start button of a post, or null without one. */
export function startButtonValue(call: SlackCall): string | null {
  for (const block of call.blocks) {
    if (block.type !== "actions" || !Array.isArray(block.elements)) continue;
    for (const element of block.elements)
      if (
        isRecord(element) &&
        element.action_id === "pantry_side_case_start" &&
        typeof element.value === "string"
      )
        return element.value;
  }
  return null;
}

/** A Slack call as the journeys record it: where it went, its text, its Start. */
export function summary(call: SlackCall) {
  return {
    method: call.method,
    channel: call.channel,
    threadTs: call.threadTs,
    ts: call.ts,
    text: call.text,
    button: startButtonValue(call),
  };
}

/**
 * A click on Start as Slack sends it: a signed form body that holds the
 * interaction payload. The proposal is a message in the thread `threadTs`.
 */
export function signedStartClick(
  input: Readonly<{
    proposalId: string;
    user: string;
    channel: string;
    threadTs: string;
    proposalTs: string;
  }>,
): Promise<Request> {
  return signedButtonClick({
    ...input,
    actionId: "pantry_side_case_start",
    value: input.proposalId,
  });
}

/** A click on one of Pantry's buttons in the message `proposalTs`. */
export async function signedButtonClick(
  input: Readonly<{
    actionId: string;
    value: string;
    user: string;
    channel: string;
    /** Null for a card that is the root of its own thread. */
    threadTs: string | null;
    proposalTs: string;
    /** The values of the card's input fields when the person clicked. */
    state?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }>,
): Promise<Request> {
  const thread = input.threadTs === null ? {} : { thread_ts: input.threadTs };
  const payload = {
    type: "block_actions",
    api_app_id: "A12345678",
    team: { id: WORKSPACE_ID, domain: "e2e-pantry" },
    user: { id: input.user, team_id: WORKSPACE_ID },
    channel: { id: input.channel },
    container: {
      type: "message",
      message_ts: input.proposalTs,
      channel_id: input.channel,
      ...thread,
    },
    message: {
      type: "message",
      ts: input.proposalTs,
      ...thread,
    },
    ...(input.state === undefined ? {} : { state: { values: input.state } }),
    trigger_id: "1787500200.trigger",
    response_url: `https://hooks.slack.com/actions/${WORKSPACE_ID}/1787500200/e2e-response`,
    actions: [
      {
        type: "button",
        action_id: input.actionId,
        block_id: "pantry_card",
        value: input.value,
        action_ts: "1787500200.000001",
      },
    ],
  };
  const rawBody = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  return new Request("http://pantry.test/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hex(new Uint8Array(digest))}`,
    },
    body: rawBody,
  });
}

/**
 * The Slack ingress Worker with the bindings of its own profile. Slack sends
 * the clicks to it, and it gives them to the platform Worker.
 */
export function slackIngressWorker(): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly forwarded: string[];
} {
  const forwarded: string[] = [];
  const bindings: SlackIngressEnv = {
    DB: env.DB,
    ORGANISATION_DB_WNAM: env.ORGANISATION_DB_WNAM,
    ORGANISATION_DB_APAC: env.ORGANISATION_DB_APAC,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE:
      env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
    VAULT_ROOT_V1: env.VAULT_ROOT_V1,
    VAULT_ROOT_V2: env.VAULT_ROOT_V2,
    PANTRY_VAULT_ACTIVE_KEY_VERSION: env.PANTRY_VAULT_ACTIVE_KEY_VERSION,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    PANTRY_DEPLOYMENT_PROFILE: env.PANTRY_DEPLOYMENT_PROFILE,
    SLACK_APP_ID: env.SLACK_APP_ID,
    CONNECTOR: env.CONNECTOR,
    PLATFORM: { fetch: giveToPlatform },
  };
  return {
    forwarded,
    fetch: function fetchIngress(request: Request): Promise<Response> {
      return handleSlackIngress(request, bindings, { waitUntil: ignore });
    },
  };

  function giveToPlatform(input: RequestInfo | URL): Promise<Response> {
    if (!(input instanceof Request))
      throw new Error("The ingress Worker gives the platform a request");
    forwarded.push(`${input.method} ${new URL(input.url).pathname}`);
    return exports.default.fetch(input);
  }
}

function ignore(): void {}

/**
 * The Slack actor fixture with a second operator, who has a linked Slack
 * account. The account authority admits that person as its private member.
 */
export async function installSlackSideCaseFixture(): Promise<
  Awaited<ReturnType<typeof installSlackActorFixture>> & {
    readonly peerUserId: string;
    readonly peerPersonId: string;
  }
> {
  const peer = await commerceClient("e2e-side-case-peer");
  const fixture = await installSlackActorFixture();
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'E2E Side Case Peer')",
      )
      .bind(ORGANISATION_ID, PEER_PERSON_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)`,
      )
      .bind(ORGANISATION_ID, peer.identity.userId, PEER_PERSON_ID, now - 1_000),
    fixtureDatabase()
      .prepare(
        `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'google')`,
      )
      .bind(
        ORGANISATION_ID,
        fixture.selectedConnectionId,
        WORKSPACE_ID,
        PEER_SLACK_USER_ID,
        peer.identity.userId,
        now - 900,
      ),
  ]);
  return {
    ...fixture,
    peerUserId: peer.identity.userId,
    peerPersonId: PEER_PERSON_ID,
  };
}

/** The last user message of one model request. */
export function lastUserText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) throw new Error("Model messages missing");
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isRecord(message) && message.role === "user")
      return JSON.stringify(message.content);
  }
  throw new Error("Model request has no user message");
}

/**
 * The person's request of the last user message, without the organisational
 * context that Pantry puts before it. That context may name other Cases'
 * messages, as for any new Case.
 */
export function currentRequest(body: Record<string, unknown>): string {
  const text = lastUserText(body);
  const start = text.indexOf("Current request:");
  if (start < 0) throw new Error("Model request has no current request");
  return text.slice(start);
}

/** The roles of the messages of one model request, in order. */
export function messageRoles(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.messages)) throw new Error("Model messages missing");
  return body.messages.map((message) =>
    isRecord(message) ? message.role : null,
  );
}

/** The text of each assistant message of one model request. */
export function assistantTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) throw new Error("Model messages missing");
  return body.messages
    .filter((message) => isRecord(message) && message.role === "assistant")
    .map((message) =>
      JSON.stringify(isRecord(message) ? message.content : null),
    );
}
