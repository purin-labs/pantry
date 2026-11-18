import { expect } from "vitest";
import type { ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  post,
  postJson,
  storedConversation,
  type Member,
} from "./memory-support";

/** Sends a message in the Portal chat, and expects the chat to take it. */
export async function ask(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  text: string,
  label: string,
): Promise<void> {
  const started = await post(person, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${label}`,
    model,
    text,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
}

/** The assistant answers that the chat shows, in order. */
export async function answers(
  person: Member,
  conversationId: ConversationId,
): Promise<string[]> {
  const stored = await storedConversation(person, conversationId);
  return (stored?.conversation.timeline ?? []).flatMap((event) =>
    event.kind === "assistant" && "text" in event ? [event.text] : [],
  );
}

/** The tool of the latest call, when the latest message is its output. */
export function lastCalledTool(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages.at(-1);
  if (!isRecord(last) || last.role !== "tool") return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.tool_calls)
    ) {
      const call: unknown = message.tool_calls.at(-1);
      return isRecord(call) &&
        isRecord(call.function) &&
        typeof call.function.name === "string"
        ? call.function.name
        : null;
    }
  }
  return null;
}

/**
 * The person's request of this turn, as Pantry quotes it in the latest user
 * message, without the organisational context that follows it.
 */
export function currentRequest(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && message.role === "user") {
      const text = JSON.stringify(message.content);
      const at = text.indexOf("Current user request");
      if (at < 0) return "";
      const end = text.indexOf("Accepted organizational context", at);
      return text.slice(at, end < 0 ? undefined : end);
    }
  }
  return "";
}

/** The proposal id of the side Case card with this title. */
export function cardId(
  cards: readonly Record<string, unknown>[],
  title: string,
): string {
  const card = cards.find((candidate) => candidate.title === title);
  if (typeof card?.proposalId !== "string")
    throw new Error(`Card missing: ${title}`);
  return card.proposalId;
}

/**
 * Waits for the chat to pause on a request other than `previous`, as the
 * Portal reads it. Returns the request and its id.
 */
export async function pausedRequest(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  previous: string | null = null,
): Promise<Readonly<{ id: string; permission: Record<string, unknown> }>> {
  await expect
    .poll(pausedRequestId.bind(null, person, chatPath, conversationId), {
      timeout: 60_000,
    })
    .toEqual(expect.not.stringMatching(`^(${previous ?? "none"})?$`));
  const work = await stateWork(person, chatPath, conversationId);
  if (
    !isRecord(work) ||
    !isRecord(work.permission) ||
    typeof work.permission.permissionRequestId !== "string"
  )
    throw new Error("The paused run has no permission request");
  expect(work.permission.permissionRequestId).toMatch(/^[0-9a-f]{32}$/u);
  return {
    id: work.permission.permissionRequestId,
    permission: work.permission,
  };
}

async function pausedRequestId(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<string> {
  const work = await stateWork(person, chatPath, conversationId);
  return isRecord(work) &&
    work.kind === "awaiting_permission" &&
    isRecord(work.permission) &&
    typeof work.permission.permissionRequestId === "string"
    ? work.permission.permissionRequestId
    : "";
}

async function stateWork(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<unknown> {
  const query = new URLSearchParams({
    conversation: conversationId,
    view: "state",
  });
  const state = await postJson(person, `${chatPath}?${query}`, null);
  expect(state.status).toBe(200);
  return isRecord(state.body) ? state.body.work : null;
}

/** Resumes the paused chat on the permission request. */
export function resumeChat(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  permissionRequestId: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return postJson(
    person,
    `${chatPath}/conversations/${conversationId}/permission`,
    { permissionRequestId, decision: "resume" },
  );
}
