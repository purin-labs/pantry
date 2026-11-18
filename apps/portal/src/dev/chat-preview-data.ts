import { isUserId, isConversationId, parseConversationId, parseProjectId, type ConversationId, type Project, type ProjectId } from "@seams/control-api";
import type { ChatStreamRecord } from "../features/chat/stream";
import {
  draftsPreviewEnabled,
  previewDraftPageData,
  previewDraftResponse,
} from "./chat-preview-drafts";
import {
  previewSideCaseResponse,
  sideCasesPreviewEnabled,
  withSideCasePreview,
} from "./chat-preview-side-cases";
import {
  executionPreviewEnabled,
  executionPreviewEvents,
  executionPreviewStream,
  executionPreviewWork,
  previewExecutionResponse,
} from "./chat-execution-preview";

import { commercePreviewAnswer, commercePreviewEnabled, previewCommerceActionResponse } from "./chat-preview-commerce";

const originalFetch = window.fetch;
const previewStreamChunks = [
  "## Shipment review\n\nI found **two shipments** in the accepted snapshot.\n\n",
  "- [x] Read shipment status\n- [ ] Review the delivery exceptions\n\n",
  "| Shipment | Status |\n| --- | --- |\n| A101 | In transit |\n| A102 | Delivered |\n\n",
  "```text\nA101: arriving tomorrow\nA102: delivered today\n```\n\nReady for your review.",
];
let previewStreamComplete = false;
const sidebarActivityPreview = new URLSearchParams(window.location.search).get("scenario") === "sidebar-activity";
let sidebarPreviewFinishesAt: number | null = null;
const previewReadSequences = new Map<string, number>();
let previewFailureAt: number | null = null;
const previewFailure = "The selected AI could not finish this response.";
export function installChatPreviewFetch(): void {
  window.fetch = previewFetch;
  if (isUserId(new URL(window.location.href).searchParams.get("preferenceUser"))) {
    document.cookie = "satyr_control_csrf=; Path=/chat-preview.html; Max-Age=0";
  } else {
    document.cookie = "satyr_control_csrf=chat-preview; Path=/chat-preview.html; SameSite=Strict";
  }
}
async function previewFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  if (!url.pathname.includes("organisation_chat_preview"))
    return originalFetch(input, init);
  const execution = previewExecutionResponse(url);
  if (execution !== null) return execution;
  if (commercePreviewEnabled()) {
    const action = previewCommerceActionResponse(url, init);
    if (action !== null) return action;
  }
  if (draftsPreviewEnabled()) {
    const draft = await previewDraftResponse(url, init);
    if (draft !== null) return draft;
  }
  if (sideCasesPreviewEnabled()) {
    const sideCase = previewSideCaseResponse(url, init);
    if (sideCase !== null) return sideCase;
  }
  if (url.pathname.endsWith("/goal")) return previewGoal(init);
  if (init?.method === "PUT" && url.pathname.endsWith("/draft"))
    return previewDraftSave(init);
  if (
    url.pathname.includes("/chat/conversations/") &&
    url.pathname.endsWith("/access")
  ) {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json(
        { kind: "rejected", message: "This preview does not change chat visibility." },
        { status: 409 },
      );
    }
    return Response.json({
      project: previewProject(),
      revision: 1,
      members: [{
        userId: "user_00000000-0000-0000-0000-000000000001",
        displayName: "Pta",
        role: "owner",
      }],
    });
  }
  if (url.pathname.endsWith("/chat/stream")) {
    if (executionPreviewEnabled()) return executionPreviewStream(init?.signal ?? null);
    if (failedStreamScenario(previewSelectedId(url)))
      return failedPreviewStreamResponse(init?.signal ?? null);
    return previewStreamResponse();
  }
  if (!url.pathname.includes("/chat/") && !url.pathname.endsWith("/chat"))
    return previewProjectsResponse(url, init);
  if (init?.method === "PATCH") return previewFeedback(init);
  if (init?.method === "POST" && url.pathname.endsWith("/read")) {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const id = url.pathname.split("/").at(-2);
    if (id !== undefined && typeof body?.sequence === "number")
      previewReadSequences.set(id, body.sequence);
    return Response.json({ read: { latestSequence: 8, lastReadSequence: body?.sequence ?? 8 } });
  }
  if (init?.method === "POST" && typeof init.body === "string") {
    const sent = JSON.parse(init.body);
    if (typeof sent.goalTokenBudget === "number") {
      previewGoalRevision += 1;
      previewGoalValue = {
        objective: sent.text,
        tokenBudget: sent.goalTokenBudget,
        tokensUsed: 0,
        state: "active",
      };
    }
  }
  if (init?.method === "POST" && questionScenario())
    return previewQuestionSend(url, init);
  if (init?.method === "POST") return previewRegenerate(url, init);
  const id = previewSelectedId(url);
  if (url.searchParams.get("view") === "state") {
    const work = executionPreviewEnabled() ? executionPreviewWork() : failedStreamScenario(id)
      ? failedPreviewWork()
      : permissionPauseScenario()
        ? permissionPauseWork()
        : { kind: "ready" };
    return Response.json({
      revision: work.kind === "failed" || previewStreamComplete ? 2 : 1,
      work,
    });
  }
  return chatPreviewResponse(withFreshPreviewChats(id, {
    derivedThreads: [],
    model: {
      kind: "ready",
      selected: "gpt-5.6-luna",
      agent: "Pi",
      name: "GPT-5.6 Luna",
      options: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: "Fast everyday work",
          capabilities: previewModelCapabilities,
        },
        {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          description: "Complex, demanding work",
          capabilities: previewModelCapabilities,
        },
      ],
    },
    projectDirectory: {
      revision: 1,
      defaultProjectId: PREVIEW_DEFAULT_PROJECT_ID,
      projects: projectsScenario() ? [previewProject()] : [],
      placements: [],
    },
    pinnedConversations: [
      {
        sharing: { visibility: "private", role: "owner" },
        id: previewConversationId("conv_00000000-0000-0000-0000-000000000001"),
        title: "Connect a shipping service",
        revision: 1,
        latestSequence: 6,
        lastReadSequence: 0,
        activity: "idle",
        lifecycle: "active",
        pinnedAt: 1,
        placement: {
          projectId: PREVIEW_DEFAULT_PROJECT_ID,
          membershipRevision: 1,
          position: 0,
        },
        updatedAt: 0,
        parentConversationId: null,
        origin: null,
      },
    ],
    pendingDeletions: [],
    nextActiveCursor: null,
    nextArchivedCursor: null,
    configurationVersion: 1,
    unreadCount: 1,
    emailReviews: [],
    slackDrafts: [],
    configurationDrafts: [],
    sideCases: [],
    sideCaseSource: null,
    conversations: [
      {
        sharing: { visibility: "private", role: "owner" },
        id: previewConversationId("conv_00000000-0000-0000-0000-000000000001"),
        title: "Connect a shipping service",
        revision: 1,
        latestSequence: 6,
        lastReadSequence: 0,
        placement: {projectId: PREVIEW_DEFAULT_PROJECT_ID, membershipRevision: 1, position: 0},
        updatedAt: 0,
        parentConversationId: null,
        origin: null,
        activity: "idle",
        lifecycle: "active",
        pinnedAt: 1,
      },
      {
        sharing: { visibility: "private", role: "owner" },
        id: previewConversationId("conv_00000000-0000-0000-0000-000000000002"),
        title: "Review the spring menu",
        revision: 1,
        latestSequence: 0,
        lastReadSequence: 0,
        placement: {projectId: PREVIEW_DEFAULT_PROJECT_ID, membershipRevision: 1, position: 0},
        updatedAt: 0,
        parentConversationId: null,
        origin: null,
        activity: "idle",
        lifecycle: "active",
        pinnedAt: null,
      },
    ],
    archivedConversations: [
      {
        sharing: { visibility: "private", role: "owner" },
        id: previewConversationId("conv_00000000-0000-0000-0000-000000000003"),
        title: "Review last month’s orders",
        revision: 1,
        latestSequence: 0,
        lastReadSequence: 0,
        placement: {projectId: PREVIEW_DEFAULT_PROJECT_ID, membershipRevision: 1, position: 0},
        updatedAt: 0,
        parentConversationId: null,
        origin: null,
        activity: "idle",
        lifecycle: "archived",
        pinnedAt: null,
        archivedAt: 1,
      },
    ],
    conversation:
      id === null
        ? null
        : {
            sharing: { visibility: "private", role: "owner" },
            lineage: { kind: "original" },
            origin: {
              area: "BakeryOS",
              page: "costs",
              title: "Costs & margins",
              record: null,
              startedAt: 0,
            },
            forkableResponseIds: ["two"],
            id,
            revision: previewStreamComplete ? 2 : 1,
            effort: null,
            timeline: [
              {
                kind: "user",
                attachments: [],
                eventId: "one",
                sequence: 1,
                requestId: "preview_request",
                createdAt: 1,
                text: "Help me connect our shipping service.",
              },
              {
                kind: "tool_started",
                eventId: "tool-start",
                sequence: 2,
                requestId: "preview_request",
                createdAt: 2,
                tool: previewTool,
              },
              {
                kind: "progress",
                eventId: "progress",
                sequence: 3,
                requestId: "preview_request",
                createdAt: 3,
                text: "Checking the provider’s documentation.",
              },
              {
                kind: "tool_settled",
                eventId: "tool-result",
                sequence: 4,
                requestId: "preview_request",
                createdAt: 4,
                tool: previewTool,
                outcome: "succeeded",
                summary: "Found the provider’s shipment-status documentation.",
                receipt: {
                  receiptId: "preview-receipt",
                  state: "succeeded",
                  summary: "Documentation read completed.",
                },
              },
              {
                kind: "assistant",
                eventId: "two",
                rating: previewRating(),
                usage: {
                  requestId: "preview_request",
                  inputTokens: 12273,
                  outputTokens: 96,
                  cachedInputTokens: null,
                  totalTokens: 12369,
                  measuredAt: 5,
                },
                sequence: 5,
                requestId: "preview_request",
                createdAt: 5,
                text: commercePreviewEnabled()
                  ? commercePreviewAnswer("/portal/nuki/cafe")
                  : "Which service do you use, and what would you like to do with it? I can help you check shipment status and prepare shipping labels.",
                ...(questionScenario() ? { question: previewQuestionForScenario() } : {}),
                sources: [
                  {
                    sourceId: "docs",
                    label: "Shipping documentation",
                    host: "example.com",
                    url: "https://example.com/shipping",
                    kind: "documentation",
                  },
                  {
                    sourceId: "export",
                    label: "shipment-summary.csv",
                    host: "Accepted export",
                    url: "https://example.com/shipment-summary.csv",
                    kind: "attachment",
                  },
                  {
                    sourceId: "unsafe",
                    label: "Unavailable reference",
                    host: "No public link",
                    url: "javascript:alert(1)",
                    kind: "tool",
                  },
                ],
              },
              ...previewQuestionAnswer(),
              ...previewStreamAnswer(),
              ...previewFailedTurn(id),
              ...previewRegeneratedAnswer(),
              ...executionPreviewEvents(),
            ],
            latestSequence: previewStreamComplete || executionPreviewEnabled() ? 7 : 6,
            lastReadSequence: 0,
            draft: { text: "", updatedAt: null },
            pendingInputs: executionPreviewEnabled() ? [
              { inputId: "queue_preview", requestId: "queue_request", text: "Prepare the kitchen handoff after the report.", mode: "next", acceptedAt: 6 },
              { inputId: "queue_preview_long", requestId: "queue_request_long", text: "Also compare this week's butter order with the supplier's last invoice, and list every line where the unit price changed by more than two percent since the previous delivery.", mode: "next", acceptedAt: 7 },
            ] : [],
            title:
              id === "conv_00000000-0000-0000-0000-000000000001"
                ? "Connect a shipping service"
                : id === "conv_00000000-0000-0000-0000-000000000003"
                  ? "Review last month’s orders"
                  : "Review the spring menu",
            projectContext: null,
            placement: {projectId: PREVIEW_DEFAULT_PROJECT_ID, membershipRevision: 1, position: 0},
            model: "gpt-5.6-luna",
            ...(id === "conv_00000000-0000-0000-0000-000000000003"
              ? {
                  lifecycle: "archived",
                  pinnedAt: null,
                  archivedAt: 1,
                }
              : {
                  lifecycle: "active",
                  pinnedAt: id === "conv_00000000-0000-0000-0000-000000000001" ? 1 : null,
                }),
            work: executionPreviewEnabled() ? executionPreviewWork() : failedStreamScenario(id)
              ? failedPreviewWork()
              : new URLSearchParams(window.location.search).get("scenario") ===
                    "running" && !previewStreamComplete
                ? {
                    kind: "running",
                    requestId: "preview_request",
                    sessionId: "preview_session",
                    turnId: "preview_turn",
                    expiresAt: Date.now() + 60000,
                  }
                : permissionPauseScenario()
                  ? permissionPauseWork()
                  : { kind: "ready" },
            messages: [
              {
                id: "one",
                kind: "user",
                text: "Help me connect our shipping service.",
              },
              {
                id: "two",
                kind: "assistant",
                text: commercePreviewEnabled()
                  ? commercePreviewAnswer("/portal/nuki/cafe")
                  : "Which service do you use, and what would you like to do with it? I can help you check shipment status and prepare shipping labels.",
              },
            ],
          },
  } satisfies Omit<ChatPageData, "emailReview"> & { emailReviews: [] }));
}

// ?scenario=permission: a run that waits for a person to allow an order read.
function permissionPauseScenario(): boolean {
  return (
    new URLSearchParams(window.location.search).get("scenario") === "permission"
  );
}

function permissionPauseWork(): import("@seams/control-api/portal/chat").ChatWork {
  return {
    kind: "awaiting_permission",
    requestId: "preview_request",
    permission: {
      permissionRequestId: "a".repeat(32),
      action: "Read customer orders",
      object: null,
      items: [
        {
          kind: "agent_request",
          itemId: "commerce.entity.read:order:requester",
          label: "Read customer orders",
          description: "Read customer orders in Portal chats and direct messages.",
        },
      ],
      requestedAt: 1,
    },
  };
}

function failedStreamScenario(id: ConversationId | null): boolean {
  return (
    id === "conv_00000000-0000-0000-0000-000000000001" &&
    new URLSearchParams(window.location.search).get("scenario") ===
      "failed-stream"
  );
}

function previewFailedTurn(
  id: ConversationId | null,
): import("@seams/control-api/portal/chat").ChatTimelineView[] {
  if (!failedStreamScenario(id) || failedPreviewWork().kind !== "failed")
    return [];
  return [
    {
      kind: "run_failed",
      eventId: "preview-failure",
      requestId: "preview_request",
      sequence: 6,
      createdAt: 6,
      text: previewFailure,
    },
  ];
}

function failedPreviewWork(): import("@seams/control-api/portal/chat").ChatWork {
  if (previewFailureAt !== null && Date.now() >= previewFailureAt)
    return {
      kind: "failed",
      requestId: "preview_request",
      error: previewFailure,
      recovery: null,
    };
  return {
    kind: "running",
    requestId: "preview_request",
    sessionId: "preview_session",
    turnId: "preview_turn",
    expiresAt: Date.now() + 60_000,
  };
}

function failedPreviewStreamResponse(signal: AbortSignal | null): Response {
  previewFailureAt = Date.now() + 1_000;
  return new Response(
    new ReadableStream<Uint8Array>({
      start: startFailedPreviewStream.bind(null, signal),
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function startFailedPreviewStream(
  signal: AbortSignal | null,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        kind: "assistant_text_delta",
        sequence: 1,
        text: "This answer is unfinished.",
      }) + "\n",
    ),
  );
  // The transport never delivers a terminal event; only the saved state changes.
  signal?.addEventListener(
    "abort",
    abortFailedPreviewStream.bind(null, controller),
    { once: true },
  );
}

function abortFailedPreviewStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.error(new DOMException("Aborted", "AbortError"));
}

function previewStreamResponse(): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  void writePreviewStream(writer);
  return new Response(stream.readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

async function writePreviewStream(
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const records: ChatStreamRecord[] =
    previewStreamChunks.map(previewStreamDelta);
  records.push({
    kind: "complete",
    sequence: records.length + 1,
    conversationRevision: 2,
  });
  const encoder = new TextEncoder();
  // A journey ends the turn when it sets the flag.
  while (
    new URLSearchParams(window.location.search).has("streamHold") &&
    (window as { previewStreamRelease?: boolean }).previewStreamRelease !== true
  )
    await previewDelay();
  for (const record of records) {
    await previewDelay();
    if (record.kind === "complete") previewStreamComplete = true;
    await writer.write(encoder.encode(`${JSON.stringify(record)}\n`));
  }
  await writer.close();
}

function previewStreamDelta(text: string, index: number): ChatStreamRecord {
  return { kind: "assistant_text_delta", sequence: index + 1, text };
}

function previewStreamAnswer(): import("@seams/control-api/portal/chat").ChatTimelineView[] {
  if (!previewStreamComplete) return [];
  return [
    {
      kind: "assistant",
      eventId: "streamed-answer",
      requestId: "preview_request",
      sequence: 7,
      createdAt: 7,
      text: previewStreamChunks.join(""),
      sources: [],
    },
  ];
}

function previewDelay(): Promise<void> {
  return new Promise(resolvePreviewDelay);
}

function resolvePreviewDelay(resolve: () => void): void {
  window.setTimeout(resolve, 600);
}
import type { ChatPageData } from "../features/chat/api";
import type { ChatModelCapabilities, ChatToolView } from "@seams/control-api";
const previewTool: ChatToolView = {
  toolCallId: "preview-documentation",
  action: "Read shipping documentation",
  object: "Shipment status API",
  destination: "Shipping provider",
  risk: "read",
  detailsExpandable: true,
};

const previewModelCapabilities: ChatModelCapabilities = {
  input: { text: true, images: false, documents: false },
  tools: true,
  progressSummaries: true,
  citations: true,
  effortOptions: ["low", "medium", "high"],
  contextWindowTokens: null,
};

const previewQuestion = {
  title: "Which shipping service do you use?",
  description: "Choose a provider so I can check its shipment API.",
  options: [
    {
      id: "easypost",
      label: "EasyPost",
      description: "Shipment status and labels",
    },
    { id: "shippo", label: "Shippo", description: "Rates and tracking" },
  ],
  allowCustom: true,
};

function questionScenario(): boolean {
  return (
    new URLSearchParams(window.location.search).get("scenario") === "question"
  );
}

function previewQuestionForScenario(): typeof previewQuestion {
  if (new URLSearchParams(window.location.search).get("question") !== "free-text") return previewQuestion;
  return {
    title: "What should the delivery team know?",
    description: "Include the receiving entrance and the delivery window.",
    options: [],
    allowCustom: true,
  };
}

function previewRating(): "good" | "bad" | null {
  const rating = sessionStorage.getItem("chat-preview-rating");
  return rating === "good" || rating === "bad" ? rating : null;
}

function previewFeedback(init: RequestInit): Response {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (
    body?.action !== "rate_response" ||
    (body.rating !== null && body.rating !== "good" && body.rating !== "bad")
  )
    return Response.json({ message: "Invalid feedback" }, { status: 422 });
  sessionStorage.setItem("chat-preview-rating", body.rating ?? "");
  return Response.json({ rating: body.rating });
}

async function previewRegenerate(
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const command = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (
    command?.kind !== "message" ||
    typeof command.text !== "string" ||
    typeof command.requestId !== "string"
  )
    return Response.json({ message: "Invalid message" }, { status: 422 });
  if (isConversationId(command.conversationId) && isFreshPreviewChat(command.conversationId)) {
    recordFreshPreviewTurn(command.conversationId, command.text, command.requestId);
    url.searchParams.set("conversation", command.conversationId);
    return previewFetch(url);
  }
  sessionStorage.setItem("chat-preview-regenerate", command.text);
  sessionStorage.setItem("chat-preview-request-id", command.requestId);
  url.searchParams.set("conversation", command.conversationId);
  return previewFetch(url);
}

// A chat started with New chat has no fixture transcript: it shows only the
// questions sent to it, each with a fixed answer, because the preview has no model.
const FIXTURE_CONVERSATION_IDS: readonly string[] = [
  "conv_00000000-0000-0000-0000-000000000001",
  "conv_00000000-0000-0000-0000-000000000002",
  "conv_00000000-0000-0000-0000-000000000003",
];
const FRESH_PREVIEW_ANSWER =
  "This is the chat preview, so no model answered. Open the Portal with a running backend to get a real answer.";
type FreshPreviewTurn = { readonly text: string; readonly requestId: string };

function freshPreviewChats(): Record<string, readonly FreshPreviewTurn[]> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem("chat-preview-fresh") ?? "{}");
    return typeof raw === "object" && raw !== null ? (raw as Record<string, readonly FreshPreviewTurn[]>) : {};
  } catch {
    return {};
  }
}

function isFreshPreviewChat(id: ConversationId): boolean {
  return !FIXTURE_CONVERSATION_IDS.includes(id) && !draftsPreviewEnabled() && !sideCasesPreviewEnabled() && !executionPreviewEnabled();
}

function recordFreshPreviewTurn(id: ConversationId, text: string, requestId: string): void {
  const chats = freshPreviewChats();
  const turns = chats[id] ?? [];
  if (turns.some((turn) => turn.requestId === requestId)) return;
  chats[id] = [...turns, { text, requestId }];
  sessionStorage.setItem("chat-preview-fresh", JSON.stringify(chats));
}

function freshPreviewTimeline(turns: readonly FreshPreviewTurn[]): import("@seams/control-api/portal/chat").ChatTimelineView[] {
  return turns.flatMap((turn, index) => [
    {
      kind: "user" as const,
      attachments: [],
      eventId: `fresh-question-${index}`,
      sequence: index * 2 + 1,
      requestId: turn.requestId,
      createdAt: index * 2 + 1,
      text: turn.text,
    },
    {
      kind: "assistant" as const,
      eventId: `fresh-answer-${index}`,
      sequence: index * 2 + 2,
      requestId: turn.requestId,
      createdAt: index * 2 + 2,
      text: FRESH_PREVIEW_ANSWER,
      sources: [],
    },
  ]);
}

function freshPreviewTitle(turns: readonly FreshPreviewTurn[]): string {
  const first = turns[0]?.text.trim() ?? "New chat";
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function withFreshPreviewChats(
  id: ConversationId | null,
  data: Omit<ChatPageData, "emailReview"> & { emailReviews: [] },
): Omit<ChatPageData, "emailReview"> & { emailReviews: [] } {
  const chats = freshPreviewChats();
  const summaries = Object.entries(chats).flatMap(([chatId, turns]) => {
    if (!isConversationId(chatId) || turns.length === 0) return [];
    return [{
      sharing: { visibility: "private" as const, role: "owner" as const },
      id: chatId,
      title: freshPreviewTitle(turns),
      revision: turns.length,
      latestSequence: turns.length * 2,
      lastReadSequence: turns.length * 2,
      placement: { projectId: PREVIEW_DEFAULT_PROJECT_ID, membershipRevision: 1, position: 0 },
      updatedAt: turns.length * 2,
      parentConversationId: null,
      origin: null,
      activity: "idle" as const,
      lifecycle: "active" as const,
      pinnedAt: null,
    }];
  });
  const withSummaries = { ...data, conversations: [...summaries.reverse(), ...data.conversations] };
  const turns = id === null ? undefined : chats[id];
  if (turns === undefined || withSummaries.conversation === null) return withSummaries;
  const timeline = freshPreviewTimeline(turns);
  return {
    ...withSummaries,
    conversation: {
      ...withSummaries.conversation,
      forkableResponseIds: [],
      revision: turns.length,
      timeline,
      latestSequence: turns.length * 2,
      lastReadSequence: turns.length * 2,
      pendingInputs: [],
      title: freshPreviewTitle(turns),
      work: { kind: "ready" },
      messages: turns.flatMap((turn, index) => [
        { id: `fresh-question-${index}`, kind: "user" as const, text: turn.text },
        { id: `fresh-answer-${index}`, kind: "assistant" as const, text: FRESH_PREVIEW_ANSWER },
      ]),
    },
  };
}

async function previewDraftSave(init: RequestInit): Promise<Response> {
  const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
  const draft =
    typeof body === "object" && body !== null && "draft" in body && typeof body.draft === "string"
      ? body.draft
      : "";
  return Response.json({ draft: { revision: 1, draft, updatedAt: Date.now() } });
}

function previewRegeneratedAnswer(): import("@seams/control-api/portal/chat").ChatTimelineView[] {
  const text = sessionStorage.getItem("chat-preview-regenerate");
  const requestId = sessionStorage.getItem("chat-preview-request-id");
  if (questionScenario() || text === null || requestId === null) return [];
  return [
    {
      kind: "user",
      attachments: [],
      eventId: "revision-request",
      sequence: 6,
      requestId,
      createdAt: 6,
      text,
    },
    {
      kind: "assistant",
      eventId: "revised-answer",
      sequence: 7,
      requestId,
      createdAt: 7,
      text: "Start by choosing your shipping provider. Then connect it to review shipments and prepare labels. No shipping actions have been repeated.",
      sources: [],
    },
  ];
}

async function previewQuestionSend(
  url: URL,
  init: RequestInit,
): Promise<Response> {
  if (typeof init.body !== "string")
    return Response.json({ message: "Missing answer" }, { status: 400 });
  const command: unknown = JSON.parse(init.body);
  if (
    typeof command !== "object" ||
    command === null ||
    !("kind" in command) ||
    command.kind !== "message" ||
    !("text" in command) ||
    typeof command.text !== "string" ||
    !("conversationId" in command) ||
    typeof command.conversationId !== "string"
  )
    return Response.json(
      { message: "Preview supports message answers only." },
      { status: 400 },
    );
  if (sessionStorage.getItem("chat-preview-question-attempt") === null) {
    sessionStorage.setItem("chat-preview-question-attempt", "failed");
    return Response.json(
      { message: "Preview delivery failed. Retry your answer." },
      { status: 503 },
    );
  }
  sessionStorage.setItem("chat-preview-question-answer", command.text);
  url.searchParams.set("conversation", command.conversationId);
  return previewFetch(url);
}

function previewQuestionAnswer(): import("@seams/control-api/portal/chat").ChatTimelineView[] {
  const text = sessionStorage.getItem("chat-preview-question-answer");
  if (!questionScenario() || text === null) return [];
  return [
    {
      kind: "user",
      attachments: [],
      eventId: "question-answer",
      sequence: 6,
      requestId: "question-answer-request",
      createdAt: 6,
      text,
    },
  ];
}

function previewProjectId(raw: string): ProjectId {
  const parsed = parseProjectId(raw);
  if (!parsed.ok) throw new Error("Invalid preview project ID");
  return parsed.value;
}

// The preview member cannot open the default Project, so chats show under its plain label.
const PREVIEW_DEFAULT_PROJECT_ID = previewProjectId(
  "project_00000000-0000-4000-8000-00000000ba5e",
);

const PREVIEW_PROJECT_ID = previewProjectId(
  "project_00000000-0000-4000-8000-000000000042",
);
// ?scenario=projects: one shared Project the member owns, holding work that Slack and email admitted.
function projectsScenario(): boolean {
  return (
    new URLSearchParams(window.location.search).get("scenario") === "projects"
  );
}
function previewProject(): Project {
  return {
    id: PREVIEW_PROJECT_ID,
    access: { kind: "shared", role: "owner", accessRevision: 1 },
    name: "Autumn menu launch",
    brief: "Plan the autumn range and its packaging.",
    references: [],
    revision: 1,
    contentRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
const previewProjectCases = [
  { caseId: "case_preview_slack", projectId: PREVIEW_PROJECT_ID, revision: 2, origin: "slack", filedAt: 1_790_000_000_000, conversationId: null },
  { caseId: "case_preview_email", projectId: PREVIEW_PROJECT_ID, revision: 1, origin: "email", filedAt: 1_790_086_400_000, conversationId: null },
];
function previewProjectsResponse(url: URL, init?: RequestInit): Response {
  if (url.pathname.endsWith("/access")) {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json(
        { kind: "rejected", message: "This preview does not change project access." },
        { status: 409 },
      );
    }
    return Response.json({
      access: { kind: "shared", role: "owner", accessRevision: 1 },
      members: [{
        userId: "user_00000000-0000-0000-0000-000000000001",
        displayName: "Pta",
        role: "owner",
      }],
      candidates: [{
        userId: "user_00000000-0000-0000-0000-000000000002",
        displayName: "Aiko · Pastry operations",
      }],
    });
  }
  if (url.pathname.endsWith("/references")) {
    return Response.json({ references: [] });
  }
  if (url.pathname.endsWith("/cases"))
    return Response.json({ cases: previewProjectCases });
  if (url.pathname.endsWith("/project") && init?.method === "POST") {
    const caseId = url.pathname.split("/").at(-2);
    const index = previewProjectCases.findIndex(previewCaseHasId.bind(null, caseId));
    if (index >= 0) previewProjectCases.splice(index, 1);
    return Response.json({ kind: "accepted" });
  }
  if (init?.method === "POST")
    return Response.json({ kind: "accepted", projectId: PREVIEW_PROJECT_ID, revision: 2 });
  return Response.json({
    defaultProject: { projectId: PREVIEW_DEFAULT_PROJECT_ID, revision: 1 },
    projects: projectsScenario() ? [previewProject()] : [],
  });
}
function previewCaseHasId(caseId: string | undefined, entry: { caseId: string }): boolean {
  return entry.caseId === caseId;
}

function previewConversationId(raw: string) {
  const parsed = parseConversationId(raw);
  if (!parsed.ok) throw new Error("Invalid preview conversation ID");
  return parsed.value;
}

function previewSelectedId(url: URL): ConversationId | null {
  const raw = url.searchParams.get("conversation");
  return isConversationId(raw) ? raw : null;
}

function chatPreviewResponse(
  data: Omit<ChatPageData, "emailReview"> & { emailReviews: [] },
): Response {
  if (sideCasesPreviewEnabled()) data = withSideCasePreview(data);
  if (sidebarActivityPreview) {
    sidebarPreviewFinishesAt ??= Date.now() + 30_000;
    data = {
      ...data,
      conversations: data.conversations.map(sidebarPreviewSummary),
      pinnedConversations: data.pinnedConversations.map(sidebarPreviewSummary),
      conversation: data.conversation === null ? null : {
        ...data.conversation,
        lastReadSequence: previewReadSequences.get(data.conversation.id) ?? 0,
      },
    };
  }
  if (data.conversation === null) return Response.json(data);
  const timeline = data.conversation.timeline.map(previewTimelineTransport);
  const sharing = new URLSearchParams(window.location.search).get("chatRole") === "viewer"
    ? { visibility: "shared", role: "viewer" }
    : data.conversation.sharing;
  return Response.json({
    ...data,
    ...(draftsPreviewEnabled() ? previewDraftPageData() : {}),
    conversation: { ...data.conversation, sharing, timeline, pendingInputs: data.conversation.pendingInputs.map(previewPendingInputTransport) },
  });
}
function sidebarPreviewSummary<
  T extends import("@seams/control-api/portal/chat").ChatConversationSummary,
>(summary: T): T {
  const working =
    summary.id.endsWith("0002") &&
    sidebarPreviewFinishesAt !== null &&
    Date.now() < sidebarPreviewFinishesAt;
  return {
    ...summary,
    activity: working ? "working" : "idle",
    latestSequence: working ? 0 : 6,
    lastReadSequence: previewReadSequences.get(summary.id) ?? 0,
  };
}

function previewTimelineTransport(
  event: import("@seams/control-api/portal/chat").ChatTimelineView,
) {
  return event.kind === "user"
    ? {
        ...event,
        parts: [{ kind: "text", text: event.text }, ...event.attachments],
      }
    : event;
}

function previewPendingInputTransport(input: import("@seams/control-api/portal/chat").ChatPendingInput) {
  return { inputId: input.inputId, requestId: input.requestId, mode: input.mode, acceptedAt: input.acceptedAt, parts: [{ kind: "text", text: input.text }] };
}

type PreviewGoalState = "active" | "paused" | "budget_limited" | "completed";
let previewGoalRevision = 1;
type PreviewGoal = {
  objective: string;
  tokenBudget: number;
  tokensUsed: number;
  state: PreviewGoalState;
};
let previewGoalValue: PreviewGoal | null = initialPreviewGoal();

function initialPreviewGoal(): PreviewGoal | null {
  const state = new URLSearchParams(window.location.search).get("goal");
  if (state !== "active" && state !== "paused" && state !== "budget_limited" && state !== "completed") return null;
  return {
    objective: "Review delayed deliveries and prepare a supplier follow-up for the café team.",
    tokenBudget: 1000000,
    tokensUsed: state === "budget_limited" ? 1000000 : 18400,
    state,
  };
}
function previewGoalView(): Response {
  const params = new URLSearchParams(window.location.search);
  const goal =
    previewGoalValue === null
      ? { kind: "none", revision: previewGoalRevision }
      : {
          kind: "present",
          revision: previewGoalRevision,
          goal: {
            goalId: "goal_preview",
            organisationId: "organisation_chat_preview",
            caseId: "case_preview",
            objective: previewGoalValue.objective,
            tokenBudget: previewGoalValue.tokenBudget,
            tokensUsed: previewGoalValue.tokensUsed,
            activeTimeMs: 13000,
            unknownOperations: params.get("goalAccess") === "unknown" ? 1 : 0,
            state:
              previewGoalValue.state === "completed"
                ? { kind: "completed", evidence: "Preview evidence" }
                : { kind: previewGoalValue.state },
          },
        };
  return Response.json({
    goal,
    support: params.get("goalAccess") === "unavailable"
      ? { kind: "unavailable", code: "connection_unavailable" }
      : { kind: "supported", backend: "pi" },
    canEdit: params.get("goalAccess") !== "viewer",
    execution: params.get("goalAccess") === "busy" ? "busy" : "idle",
  });
}
function previewGoal(init?: RequestInit): Response {
  const fault = new URLSearchParams(window.location.search).get("goalFault");
  // A journey sets the flag to end or to start the fault, and reads the count.
  const journey = window as { previewGoalReadFails?: boolean; previewGoalReadFailures?: number };
  if ((journey.previewGoalReadFails ?? fault === "read") && init?.method !== "POST") {
    journey.previewGoalReadFailures = (journey.previewGoalReadFailures ?? 0) + 1;
    return Response.json({ error: "Goal is temporarily unavailable." }, { status: 503 });
  }
  if (init?.method !== "POST" || typeof init.body !== "string")
    return previewGoalView();
  if (fault === "conflict") {
    previewGoalRevision += 1;
    if (previewGoalValue !== null) previewGoalValue.objective = "Updated by another operator.";
    return Response.json({ error: "The goal changed in another session. Review it before saving." }, { status: 409 });
  }
  const { command } = JSON.parse(init.body);
  previewGoalRevision += 1;
  if (command.kind === "set")
    previewGoalValue = {
      objective: command.objective,
      tokenBudget: command.tokenBudget,
      tokensUsed: previewGoalValue?.tokensUsed ?? 18400,
      state: previewGoalValue?.state === "paused" ? "paused" : "active",
    };
  else if (command.kind === "clear") previewGoalValue = null;
  else if (previewGoalValue !== null) {
    if (command.kind === "pause") previewGoalValue.state = "paused";
    if (command.kind === "resume") previewGoalValue.state = "active";
    if (command.kind === "complete") previewGoalValue.state = "completed";
  }
  return previewGoalView();
}
