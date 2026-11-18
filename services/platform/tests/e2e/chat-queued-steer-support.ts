import { http, type HttpResponseResolver } from "msw";
import { expect, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import { network } from "./network";
import {
  controlPaths,
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  type Member,
} from "./memory-support";
import { openRouterText } from "./slack-journey-support";

/** The chat of a queued steer journey: its first model request waits. */
type Model = {
  readonly requests: Record<string, unknown>[];
  /** When each model request arrived. */
  readonly requestedAt: number[];
  readonly firstStarted: PromiseWithResolvers<void>;
  readonly releaseFirst: PromiseWithResolvers<void>;
  readonly first: () => Response;
};

export async function startHeldChat(
  test: TestContext,
  first: () => Response,
): Promise<{
  readonly owner: Member;
  readonly route: string;
  readonly conversationId: ConversationId;
  readonly model: Model;
}> {
  const fixture = await installMemoryFixture();
  const model: Model = {
    requests: [],
    requestedAt: [],
    firstStarted: Promise.withResolvers<void>(),
    releaseFirst: Promise.withResolvers<void>(),
    first,
  };
  test.onTestFinished(() => model.releaseFirst.resolve());
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(fixture.author, conversationId, fixture.route);
  return {
    owner: fixture.author,
    route: fixture.route.model,
    conversationId,
    model,
  };
}

async function replyToModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  model.requests.push(body);
  model.requestedAt.push(Date.now());
  const number = model.requests.length;
  if (number > 1)
    return openRouterText(replyText(`Answer ${number}`), `answer_${number}`);
  // The run is busy while this request waits.
  model.firstStarted.resolve();
  await model.releaseFirst.promise;
  return model.first();
}

export function replyText(text: string): string {
  return JSON.stringify({ kind: "reply", text });
}

export async function send(
  owner: Member,
  model: string,
  conversationId: ConversationId,
  kind: "message" | "next",
  name: string,
  text: string,
  browserInstanceId: string,
): Promise<void> {
  const response = await post(owner, controlPaths(owner.organisationId).chat, {
    kind,
    conversationId,
    requestId: `request_${name}`,
    ...(kind === "next" ? { inputId: `input_${name}` } : {}),
    model,
    text,
    surfaceContext: null,
    browserContext: {
      kind: "available",
      binding: { browserInstanceId, conversationId },
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

export async function queuedRequests(
  owner: Member,
  conversationId: ConversationId,
): Promise<string[]> {
  const stored = await storedConversation(owner, conversationId);
  return (stored?.conversation.pendingInputs ?? []).map(
    (input) => input.requestId,
  );
}

export async function queueIsDone(
  owner: Member,
  conversationId: ConversationId,
): Promise<boolean> {
  const stored = await storedConversation(owner, conversationId);
  return (
    stored?.conversation.work.kind === "ready" &&
    stored.conversation.pendingInputs.length === 0
  );
}

export type TimelineEvent = Readonly<{ kind: string; text?: unknown }>;

export async function timelineOf(
  owner: Member,
  conversationId: ConversationId,
): Promise<readonly TimelineEvent[]> {
  const stored = await storedConversation(owner, conversationId);
  return stored?.conversation.timeline ?? [];
}

export function textsOf(
  kind: string,
  timeline: readonly TimelineEvent[],
): unknown[] {
  return timeline
    .filter((event) => event.kind === kind)
    .map((event) => event.text);
}

export function isCancellation(event: TimelineEvent): boolean {
  return event.kind === "run_cancelled";
}

export const TAB = "5b726c04-dfcb-4e24-9a0e-1f8e5c6d2a31";
export const OTHER_TAB = "6c837d15-e0dc-4f35-8b1f-2a9f6d7e3b42";
