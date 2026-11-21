import { exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import { readConversation } from "../../src/chat/store";
import { preparePortalChatJourney } from "./chat-journey-support";
import { connectModelApiKey } from "./chatgpt-subscription-support";
import {
  modelIds,
  readChat,
  readWork,
  sendMessage,
} from "./chat-model-choice-support";
import { commerceHeaders } from "./commerce-support";
import { MODEL_EXIT_EGRESS_HEADER } from "./model-exit-network";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { ORGANISATION_ID, SLACK_ACTOR_USER_ID } from "./slack-journey-support";
import { requireOrganisationId, requireUserId } from "../test-ids";

/**
 * An owner chats in Portal on the organisation's own Gemini API key (spec
 * FND-04, Plan 96 J3 and J4).
 *
 * The model menu offers Gemini 4 Hydrogen, Carbon, Argon and Neon, and a new
 * chat starts on Hydrogen. Each request leaves through the model exit Worker
 * with the organisation's key. A chat on Carbon at high effort reaches the
 * Gemini API with that model and level; its model calls a tool with a thought
 * signature, and the next request gives the signature back. A model that the
 * menu does not offer is refused before any request leaves. A fork of the
 * Carbon chat starts a new lineage from the accepted history, and its first
 * request still carries the signature of the earlier call.
 */
it(
  "runs Portal chats on the organisation's Gemini key and keeps thought signatures across a fork",
  geminiKeyJourney,
  180_000,
);

const GEMINI_KEY = "AIzaE2EGeminiKeyPortalJourney0000000001";
const DEFAULT_CHAT = "conv_6a1f3c2e-9b4d-4e7a-8c5f-1d2e3f4a5b01";
const CARBON_CHAT = "conv_7b2e4d3f-0c5e-4f8b-9d6a-2e3f4a5b6c02";
const UNOFFERED_CHAT = "conv_8c3f5e4a-1d6f-4a9c-8e7b-3f4a5b6c7d03";
const SIGNATURE = "c2lnbmF0dXJlLWNhcmJvbi10b29sLWNhbGwtMQ==";
const REPLY = "Twelve croissants are left for this afternoon.";

type GeminiRequest = Readonly<{
  model: string;
  body: Record<string, unknown>;
}>;

async function geminiKeyJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const gemini = new FakeGemini(GEMINI_KEY);
  gemini.install();
  // The chat fixture starts on the Pantry-funded OpenRouter route.
  await connectModelApiKey("google", GEMINI_KEY);

  const menu = (await readChat(session, null)).model;
  expect(menu).toMatchObject({
    kind: "ready",
    agent: "Pi",
    selected: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
  });
  expect(modelIds(menu)).toEqual([
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-neon",
  ]);

  // A new chat on the model that the menu selects.
  gemini.answers.push(textAnswer(REPLY));
  expect(
    await sendMessage(session, {
      conversationId: DEFAULT_CHAT,
      requestId: "request_gemini_default",
      model: String(menu.selected),
      text: "How many croissants are left?",
    }),
  ).toMatchObject({ status: 200 });
  await expect
    .poll(readWork.bind(null, session, DEFAULT_CHAT), { timeout: 30_000 })
    .toBe("ready");
  expect(
    JSON.stringify((await readChat(session, DEFAULT_CHAT)).conversation),
  ).toContain(REPLY);
  expect(gemini.requests.map(modelOf)).toEqual(["gemini-4-hydrogen"]);

  // Carbon at high effort, with one tool call before the answer.
  gemini.answers.push(toolSearchAnswer, textAnswer(REPLY));
  expect(
    await sendMessage(session, {
      conversationId: CARBON_CHAT,
      requestId: "request_gemini_carbon",
      model: "gemini-4-carbon",
      effort: "high",
      text: "Find the tool for the croissant stock, then tell me the count.",
    }),
  ).toMatchObject({ status: 200 });
  await expect
    .poll(readWork.bind(null, session, CARBON_CHAT), { timeout: 60_000 })
    .toBe("ready");
  const carbonChat = await readChat(session, CARBON_CHAT);
  expect(JSON.stringify(carbonChat.conversation)).toContain(REPLY);
  expect(carbonChat.model).toMatchObject({
    selected: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
  });
  expect(gemini.requests.map(modelOf)).toEqual([
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-4-carbon",
  ]);
  expect(thinkingLevel(gemini.requests[1])).toBe("HIGH");
  // Pi gives the signature of the call back with the tool's result.
  expect(signedCalls(gemini.requests[2])).toEqual([
    { name: "tool_search", thoughtSignature: SIGNATURE },
  ]);

  // A Gemini model that the menu does not offer.
  const unoffered = await sendMessage(session, {
    conversationId: UNOFFERED_CHAT,
    requestId: "request_gemini_unoffered",
    model: "gemini-4-ultra",
    text: "Check the bakery stock.",
  });
  expect(unoffered).toMatchObject({
    status: 422,
    body: { error: "chat_model_invalid" },
  });
  expect(gemini.requests).toHaveLength(3);

  // J4: a fork starts a new lineage from the accepted history.
  const forkId = await forkAtLastAnswer(session, CARBON_CHAT);
  gemini.answers.push(textAnswer(REPLY));
  expect(
    await sendMessage(session, {
      conversationId: forkId,
      requestId: "request_gemini_fork",
      model: "gemini-4-carbon",
      effort: "high",
      text: "And how many pains au chocolat?",
    }),
  ).toMatchObject({ status: 200 });
  await expect
    .poll(readWork.bind(null, session, forkId), { timeout: 60_000 })
    .toBe("ready");
  expect(gemini.requests).toHaveLength(4);
  expect(modelOf(gemini.requests[3])).toBe("gemini-4-carbon");
  expect(signedCalls(gemini.requests[3])).toEqual([
    { name: "tool_search", thoughtSignature: SIGNATURE },
  ]);

  Object.assign(test.task.meta, {
    geminiKeyPortal: {
      menu: modelIds(menu),
      requests: gemini.requests.map(requestSummary),
      unofferedModel: unoffered,
      forkSignature: signedCalls(gemini.requests[3]),
    },
  });
}

type GeminiAnswer = (request: GeminiRequest) => readonly unknown[];

function textAnswer(text: string): GeminiAnswer {
  return () => [{ text: JSON.stringify({ kind: "reply", text }) }];
}

/** The model calls `tool_search` once, with a thought signature. */
function toolSearchAnswer(request: GeminiRequest): readonly unknown[] {
  const names = declaredFunctions(request.body);
  if (!names.includes("tool_search"))
    throw new Error(`tool_search is not offered: ${names.join(", ")}`);
  return [
    {
      functionCall: { name: "tool_search", args: { query: "croissant stock" } },
      thoughtSignature: SIGNATURE,
    },
  ];
}

/**
 * A fake Gemini API for the organisation's own key. It records each request
 * and answers with the next prepared answer. Like the Gemini API, it refuses
 * a key that it did not issue, and it refuses each request that did not leave
 * through the model exit Worker: the Gemini API refuses Hong Kong.
 */
class FakeGemini {
  readonly requests: GeminiRequest[] = [];
  readonly answers: GeminiAnswer[] = [];

  constructor(readonly apiKey: string) {}

  install(): void {
    network.use(
      http.post(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+$/,
        this.respond.bind(this),
      ),
    );
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (!request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return geminiError(
        400,
        "FAILED_PRECONDITION",
        "User location is not supported for the API use.",
      );
    if (request.headers.get("x-goog-api-key") !== this.apiKey)
      return geminiError(400, "INVALID_ARGUMENT", "API key not valid.");
    const action = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const [model, method] = action.split(":");
    if (method !== "streamGenerateContent" || model === undefined)
      throw new Error(`Unexpected Gemini call ${action}`);
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Gemini request body is invalid");
    const recorded = { model, body };
    this.requests.push(recorded);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("No Gemini answer is prepared");
    const chunk = {
      candidates: [
        {
          content: { role: "model", parts: answer(recorded) },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 40,
        candidatesTokenCount: 6,
        totalTokenCount: 46,
      },
      modelVersion: model,
    };
    return new HttpResponse(`data: ${JSON.stringify(chunk)}\r\n\r\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
}

function geminiError(
  status: number,
  reason: string,
  message: string,
): Response {
  return HttpResponse.json(
    { error: { code: status, message, status: reason } },
    { status },
  );
}

function modelOf(request: GeminiRequest | undefined): string | undefined {
  return request?.model;
}

function thinkingLevel(request: GeminiRequest | undefined): unknown {
  const config = request?.body.generationConfig;
  return isRecord(config) && isRecord(config.thinkingConfig)
    ? config.thinkingConfig.thinkingLevel
    : null;
}

function declaredFunctions(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool: unknown) =>
    isRecord(tool) && Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations.flatMap((declaration: unknown) =>
          isRecord(declaration) && typeof declaration.name === "string"
            ? [declaration.name]
            : [],
        )
      : [],
  );
}

/** Each function call in the history of a request, with its signature. */
function signedCalls(request: GeminiRequest | undefined): unknown[] {
  const contents = Array.isArray(request?.body.contents)
    ? request.body.contents
    : [];
  return contents.flatMap((content: unknown) =>
    isRecord(content) && Array.isArray(content.parts)
      ? content.parts.flatMap((part: unknown) =>
          isRecord(part) && isRecord(part.functionCall)
            ? [
                {
                  name: part.functionCall.name,
                  thoughtSignature: part.thoughtSignature ?? null,
                },
              ]
            : [],
        )
      : [],
  );
}

function requestSummary(request: GeminiRequest): unknown {
  return {
    model: request.model,
    thinkingLevel: thinkingLevel(request),
    signedCalls: signedCalls(request),
  };
}

/** Forks the chat at its last accepted answer, as Portal does. */
async function forkAtLastAnswer(
  session: IssuedControlSession,
  sourceId: string,
): Promise<string> {
  const stored = await readConversation(
    fixtureDatabase(),
    {
      organisationId: requireOrganisationId(ORGANISATION_ID),
      userId: requireUserId(SLACK_ACTOR_USER_ID),
    },
    sourceId,
  );
  const binding = stored?.conversation.historyBindings.at(-1);
  if (binding === undefined || binding.responseId === null)
    throw new Error("The Carbon chat committed no history");
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${sourceId}`,
    {
      method: "PATCH",
      headers: commerceHeaders(session),
      body: JSON.stringify({
        action: "fork",
        operationId: "operation_gemini_fork",
        messageId: binding.responseId,
      }),
    },
  );
  const raw: unknown = await response.json();
  if (
    response.status !== 200 ||
    !isRecord(raw) ||
    raw.kind !== "ready" ||
    typeof raw.conversationId !== "string"
  )
    throw new Error(`Fork refused: ${JSON.stringify(raw)}`);
  return raw.conversationId;
}
