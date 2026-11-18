import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import type { CaseGoalCommand } from "@seams/contracts";
import { isRecord } from "@seams/std";
import { readOrganisationCodexConnection } from "../../src/models/codex-connection";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "../../src/ids";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import {
  createRequiredGrant,
  installSlackActorFixture,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  connectChatGptSubscription,
  type FakeChatGpt,
} from "./chatgpt-subscription-support";

export const CONVERSATION_ID = "conv_719795b9-7490-4476-b8f5-40463dafd29a";

/**
 * The Slack actor's Organisation, ready for Portal chat. With `chatgpt`, its
 * owner signs in to ChatGPT and the subscription becomes its inference route.
 * `account` names one more person whom the account authority admits.
 */
export async function preparePortalChatJourney(
  options: Readonly<{
    account?: Parameters<typeof installSlackActorFixture>[0];
    chatgpt?: FakeChatGpt;
  }> = {},
): Promise<{
  session: IssuedControlSession;
  fixture: Awaited<ReturnType<typeof installSlackActorFixture>>;
}> {
  const fixture = await installSlackActorFixture(options.account ?? {});
  const identity = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!identity.ok) throw new Error(identity.error.code);
  if (options.chatgpt !== undefined) {
    options.chatgpt.install();
    await connectChatGptSubscription(options.chatgpt);
  }
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .run();
  await createRequiredGrant({
    grantId: "grant_credit_chat_read",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'receipt_credit', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });

  return { session, fixture };
}

export function readConnection(reconcile: boolean) {
  return readOrganisationCodexConnection({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
    reconcile,
  });
}

export async function readFailureReason(): Promise<string> {
  const connection = await readConnection(false);
  return connection.ok && connection.value.kind === "action_required"
    ? connection.value.reason
    : "none";
}

export async function readWork(session: IssuedControlSession): Promise<string> {
  const raw: unknown = await (await chat(session, null)).json();
  if (
    !isRecord(raw) ||
    !isRecord(raw.conversation) ||
    !isRecord(raw.conversation.work)
  )
    return "missing";
  return typeof raw.conversation.work.kind === "string"
    ? raw.conversation.work.kind
    : "missing";
}

export function chat(
  session: IssuedControlSession,
  turn: number | null,
): Promise<Response> {
  return requestChat(
    session,
    turn === null ? { kind: "read" } : { kind: "message", turn },
  );
}

export function retryChat(
  session: IssuedControlSession,
  turn: number,
): Promise<Response> {
  return requestChat(session, { kind: "retry", turn });
}

export function goalCommand(
  session: IssuedControlSession,
  expectedRevision: number,
  command: CaseGoalCommand,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${CONVERSATION_ID}/goal`,
      {
        method: "POST",
        headers: {
          origin: "https://localhost",
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          "content-type": "application/json",
          "x-satyr-csrf": session.csrfToken,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision,
          command,
        }),
      },
    ),
  );
}

function requestChat(
  session: IssuedControlSession,
  request: { kind: "read" } | { kind: "message" | "retry"; turn: number },
): Promise<Response> {
  let body: string | undefined;
  if (request.kind === "message") {
    body = JSON.stringify({
      kind: "message",
      conversationId: CONVERSATION_ID,
      requestId: `request_credit_${request.turn}`,
      model: "gpt-5.6-luna",
      text: `Credit continuation ${request.turn}`,
      surfaceContext: null,
    });
  } else if (request.kind === "retry") {
    body = JSON.stringify({
      kind: "retry",
      conversationId: CONVERSATION_ID,
      requestId: `request_credit_${request.turn}`,
      model: "gpt-5.6-luna",
    });
  }
  const query =
    request.kind === "read" ? `?conversation=${CONVERSATION_ID}` : "";
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat${query}`,
    {
      method: request.kind === "read" ? "GET" : "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body,
    },
  );
}
