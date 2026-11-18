import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { fixtureDatabase } from "./organisation-database";
import { newConversationId, type ConversationId } from "@seams/control-api";
import type { CaseGoalCommand } from "@seams/contracts";
import { isRecord } from "@seams/std";
import { readOrganisationCodexConnection } from "../../src/models/codex-connection";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId, type OrganisationId } from "../../src/ids";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import type { SessionDO } from "../../src/actors/agent-session";
import type { Conversation } from "../../src/chat/conversation";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
} from "../../src/chat/conversation-actor-identity";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { ask } from "./chat-permission-support";
import { commerceHeaders } from "./commerce-support";
import {
  PUBLIC_ORIGIN,
  controlReadHeaders,
} from "./hibernatable-socket-support";
import {
  createConversation,
  emptyConversation,
  postJson,
  workKind,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import {
  createRequiredGrant,
  installSlackActorFixture,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  connectChatGptSubscription,
  textAnswer,
  type ChatGptAnswer,
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

/** An admin's agent command through the API, with its idempotency key. */
export function dispatchCommand(
  session: IssuedControlSession,
  key: string,
  instruction: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/cases/commands`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({ instruction }),
    },
  );
}

/** The active Session Actor of the journey's Organisation. */
export async function sessionOf(
  sessionId: Parameters<typeof resolveActiveSessionActor>[0]["sessionId"],
): Promise<DurableObjectStub<SessionDO>> {
  const resolved = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

/** The active Case Actor of the journey's Organisation. */
export async function caseOf(
  caseId: Parameters<typeof resolveActiveCaseActor>[0]["caseId"],
) {
  const resolved = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

/** The state of one turn's stream, or the code of a refused read. */
export async function turnState(
  session: DurableObjectStub<SessionDO>,
  turnId: string,
): Promise<string> {
  const inspected = await session.inspectTurnStream({
    organisationId: ORGANISATION_ID,
    turnId,
  });
  if (!inspected.ok) return inspected.error.code;
  return inspected.value.kind === "missing" ? "missing" : inspected.value.state;
}

/** The lifecycle of each assignment of the Case, from its full read. */
export async function assignmentStates(
  caseActor: Awaited<ReturnType<typeof caseOf>>,
): Promise<string[]> {
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return snapshot.value.assignmentLifecycles.map((lifecycle) =>
    lifecycle.kind === "settled"
      ? `settled:${lifecycle.disposition.kind}`
      : lifecycle.kind,
  );
}

/** Older than the 30-minute abandon time. */
const OLD_START_AGE_MS = 31 * 60_000;

/**
 * What a Case of the older release holds: no wakeup, no assignment time, and
 * a start older than the abandon time.
 */
export async function leaveOldAssignment(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.deleteAlarm();
  const rows = state.storage.sql
    .exec<{ assignment_id: string; lifecycle_json: string }>(
      "SELECT assignment_id, lifecycle_json FROM case_assignment",
    )
    .toArray();
  for (const row of rows) {
    const lifecycle: unknown = JSON.parse(row.lifecycle_json);
    if (!isRecord(lifecycle) || !isRecord(lifecycle.start))
      throw new Error("case_assignment_start_missing");
    const acceptedAt = Number(lifecycle.start.acceptedAt) - OLD_START_AGE_MS;
    lifecycle.start.acceptedAt =
      typeof lifecycle.start.acceptedAt === "string"
        ? String(acceptedAt)
        : acceptedAt;
    state.storage.sql.exec(
      "UPDATE case_assignment SET lifecycle_json = ?, assigned_at = NULL WHERE assignment_id = ?",
      JSON.stringify(lifecycle),
      row.assignment_id,
    );
  }
}

/** ChatGPT's answer to one turn, after the journey's next step for it. */
export async function answerTurn(
  turns: (() => Promise<void>)[],
  _request: unknown,
  index: number,
): Promise<ChatGptAnswer> {
  await turns.shift()?.();
  return textAnswer(
    JSON.stringify({ kind: "reply", text: `TURN_${String(index + 1)}_OK` }),
  );
}

/**
 * A Portal chat with no turn yet, titled `title`, on the platform route of
 * `model`.
 */
export function platformConversation(
  id: ConversationId,
  title: string,
  model = "fixture",
): Conversation {
  return {
    ...emptyConversation(id, {
      keySource: "platform",
      provider: "openai-compatible",
      model,
    }),
    title,
  };
}

/** A control request of one person: a read when `body` is null. */
export function controlFetch(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/${path}`,
    {
      method: body === null ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: body === null ? null : JSON.stringify(body),
    },
  );
}

/** A control request of one person with its own method, from the Portal. */
export function control(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/${path}`,
    {
      method,
      headers: {
        origin: PUBLIC_ORIGIN,
        ...controlReadHeaders(session),
        "x-satyr-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    },
  );
}

/** The Case Actor of one person's Portal chat. */
export async function conversationCase(
  person: Member,
  conversationId: ConversationId,
) {
  const caseId = await conversationCaseId(
    initialConversationCaseIdentity(
      { organisationId: person.organisationId, userId: person.userId },
      conversationId,
    ),
  );
  const actor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: person.organisationId,
    caseId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}

/** A new chat of one person whose message holds `word`. */
export async function startChat(
  fixture: MemoryFixture,
  person: Member,
  word: string,
): Promise<ConversationId> {
  const conversationId = newConversationId();
  await createConversation(person, conversationId, fixture.route);
  await ask(
    person,
    fixture.paths.chat,
    conversationId,
    fixture.route.model,
    `${word} now.`,
    word,
  );
  return conversationId;
}

/** One chat message that needs no prompt. A pause fails the poll. */
export async function chatDirect(
  fixture: MemoryFixture,
  person: Member,
  word: string,
): Promise<void> {
  await finished(person, await startChat(fixture, person, word));
}

/** Waits until the chat's work is ready again. */
export function finished(
  person: Member,
  conversationId: ConversationId,
): Promise<void> {
  return expect
    .poll(workKind.bind(null, person, conversationId), { timeout: 60_000 })
    .toBe("ready");
}

/** The agent's mutation receipts on one route, counted by operation. */
export async function agentReceipts(
  fixture: MemoryFixture,
  route: string,
): Promise<unknown> {
  const scope = await requireOrganisationExecutionScope(
    env,
    fixture.organisationId,
  );
  const rows = await scope.database
    .prepare(
      "SELECT operation, COUNT(*) AS n FROM control_mutation_receipt WHERE organisation_scope = ? AND route = ? AND substr(idempotency_key, 1, 6) = 'agent_' GROUP BY operation ORDER BY operation",
    )
    .bind(fixture.organisationId, route)
    .all();
  return rows.results;
}

/** A configuration draft card of a chat, as the chat read lists it. */
export type DraftView = Readonly<{
  draftId: string;
  summary: string;
  actionLabel: string;
  state: string;
}>;

/** The one configuration draft that a chat lists. */
export async function onlyDraft(
  fixture: MemoryFixture,
  person: Member,
  conversationId: ConversationId,
): Promise<DraftView> {
  const query = new URLSearchParams({ conversation: conversationId });
  const read = await postJson(person, `${fixture.paths.chat}?${query}`, null);
  const body = read.body;
  if (!isRecord(body) || !Array.isArray(body.configurationDrafts))
    throw new Error(`No drafts: ${JSON.stringify(body).slice(0, 400)}`);
  const drafts = body.configurationDrafts.filter((draft): draft is DraftView =>
    isRecord(draft),
  );
  expect(drafts).toHaveLength(1);
  const draft = drafts[0];
  if (draft === undefined) throw new Error("No draft");
  return draft;
}

/** One person's confirm or cancel of a configuration draft card. */
export function draftAction(
  fixture: MemoryFixture,
  person: Member,
  conversationId: ConversationId,
  draft: Readonly<{ draftId: string }>,
  action: "confirm" | "cancel",
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set("x-satyr-configuration-version", "1");
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}${fixture.paths.organisation}/chat/conversations/${conversationId}/configuration-drafts/${draft.draftId}/${action}`,
    { method: "POST", headers, body: "{}" },
  );
}

/** The user messages that a chat read's timeline shows with a screen. */
export function userScreenParts(
  read: Readonly<{ conversation: Record<string, unknown> }>,
): readonly unknown[] {
  const timeline = Array.isArray(read.conversation.timeline)
    ? read.conversation.timeline
    : [];
  return timeline.flatMap((event: unknown) =>
    isRecord(event) && event.kind === "user" && Array.isArray(event.parts)
      ? event.parts.filter(
          (part: unknown) => isRecord(part) && part.kind === "screen",
        )
      : [],
  );
}

/** The word of the chat message: each chat holds one. */
export function messageWord(
  body: Record<string, unknown>,
  words: readonly string[],
): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = JSON.stringify(message.content);
    const word = words.find((candidate) => text.includes(candidate));
    if (word !== undefined) return word;
  }
  throw new Error("The model request has no scripted message");
}

/** The newest user message of the newest model request. */
export function latestUserInput(requests: readonly string[]): string {
  const latest = requests.at(-1);
  if (latest === undefined) throw new Error("The model received no request");
  const body: unknown = JSON.parse(latest);
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && message.role === "user")
      return JSON.stringify(message.content);
  }
  throw new Error("The model request has no user message");
}

/** The name of the tool that the newest assistant message called. */
export function lastToolCallName(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const call: unknown = calls.at(-1);
    return isRecord(call) &&
      isRecord(call.function) &&
      typeof call.function.name === "string"
      ? call.function.name
      : null;
  }
  return null;
}

/** How many tool results one model request already carries. */
export function modelToolResults(raw: unknown): number {
  return isRecord(raw) && Array.isArray(raw.messages)
    ? raw.messages.filter(
        (message: unknown) => isRecord(message) && message.role === "tool",
      ).length
    : 0;
}

/** The newest tool result of a model request, or "" when it has none. */
export function toolOutput(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.filter(
    (message) => isRecord(message) && message.role === "tool",
  );
  const message = last.at(-1);
  return isRecord(message) ? JSON.stringify(message.content) : "";
}
