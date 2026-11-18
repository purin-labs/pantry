import { requireConversationId, requireProjectId } from "./test-ids";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatDraftConflictError, type saveChatDraft, type postChatCommand, type cancelChat, type readChat } from "../../../apps/portal/src/features/chat/api";
import type { Chat } from "@seams/control-api/portal/chat";
// @ts-expect-error The portal build type-checks JSX separately from platform tests.
import { ChatPage } from "../../../apps/portal/src/features/chat/route";

const transport = vi.hoisted(function createTransport() {
  return {
    save: vi.fn<typeof saveChatDraft>(),
    send: vi.fn<typeof postChatCommand>(),
    cancel: vi.fn<typeof cancelChat>(),
    read: vi.fn<typeof readChat>(),
  };
});

vi.mock("../../../apps/portal/src/features/chat/api", mockChatApi);
vi.mock("../../../apps/portal/src/features/chat/screen-send", () => ({
  sendChat: transport.send,
}));

async function mockChatApi(importOriginal: () => Promise<object>) {
  return {
    ...(await importOriginal()),
    saveChatDraft: transport.save,
    cancelChat: transport.cancel,
    readChat: transport.read,
  };
}

beforeEach(function setup() {
  vi.resetAllMocks();
  vi.stubGlobal("document", { removeEventListener: vi.fn() });
  vi.stubGlobal("window", {
    location: { search: "?conversation=conv_7d980f41-a532-5387-9ea1-548f956b6e3e" },
    clearTimeout,
    setTimeout,
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), speak: vi.fn() });
});

afterEach(function cleanup() {
  vi.unstubAllGlobals();
});

it("uses each accepted draft token for the next autosave", async function savesSuccessiveEdits() {
  const page = createPage({ kind: "ready" });
  editDraft(page, "First edit");
  transport.save.mockResolvedValueOnce({
    revision: 2,
    draft: "First edit",
    updatedAt: 10,
  });
  await invokePage(page, "saveDraft");
  editDraft(page, "Second edit");
  transport.save.mockResolvedValueOnce({
    revision: 3,
    draft: "Second edit",
    updatedAt: 11,
  });
  await invokePage(page, "saveDraft");
  expect(transport.save.mock.calls).toEqual([
    ["organisation_test", "conv_7d980f41-a532-5387-9ea1-548f956b6e3e", "First edit", null],
    ["organisation_test", "conv_7d980f41-a532-5387-9ea1-548f956b6e3e", "Second edit", 10],
  ]);
  expect(page.state.draft).toBe("Second edit");
  expect(page.state.page).toMatchObject({
    data: { conversation: { draft: { text: "Second edit", updatedAt: 11 } } },
  });
});

it("flushes edits made during an in-flight save after unmount", async function flushesLatestDraft() {
  const page = createPage({ kind: "ready" });
  const firstSave =
    Promise.withResolvers<Awaited<ReturnType<typeof saveChatDraft>>>();
  transport.save.mockReturnValueOnce(firstSave.promise);
  transport.save.mockResolvedValueOnce({
    revision: 3,
    draft: "Final edit",
    updatedAt: 11,
  });
  editDraft(page, "First edit");
  const saving = invokePage(page, "saveDraft");
  editDraft(page, "Final edit");
  page.componentWillUnmount();
  expect(transport.save).toHaveBeenCalledTimes(1);
  firstSave.resolve({ revision: 2, draft: "First edit", updatedAt: 10 });
  await saving;
  expect(transport.save.mock.calls[1]).toEqual([
    "organisation_test",
    requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    "Final edit",
    10,
  ]);
  expect(transport.save).toHaveBeenCalledTimes(2);
});

it("returns a draft that a navigation flush could not save when its chat opens again", async function keepsConflictingDraft() {
  const page = createPage({ kind: "ready" });
  const firstId = requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e");
  const otherId = requireConversationId("conv_2b1c4e6a-0f3d-5a8b-9c7e-1d2f3a4b5c6d");
  editDraft(page, "Unsaved local text");
  transport.save.mockRejectedValueOnce(
    new ChatDraftConflictError("Other window", 2, 10),
  );
  transport.read.mockResolvedValueOnce(pageData({ ...createChat({ kind: "ready" }), id: otherId }));
  await invokePage(page, "selectThread", otherId, false);
  expect(page.state.page).toMatchObject({ data: { conversation: { id: otherId } } });
  expect(page.state.draft).toBe("");

  transport.read.mockResolvedValueOnce(
    pageData({ ...createChat({ kind: "ready" }), draft: { text: "Other window", updatedAt: 10 } }),
  );
  await invokePage(page, "selectThread", firstId, false);
  expect(page.state.page).toMatchObject({ data: { conversation: { id: firstId } } });
  expect(page.state.draft).toBe("Unsaved local text");
  expect(transport.save).toHaveBeenCalledTimes(1);
});

it("retries the current expired turn and leaves a live turn alone", async function retriesExpiredTurn() {
  const work = {
    kind: "running",
    requestId: "request_test",
    expiresAt: 1,
    sessionId: "session_test",
    turnId: "turn_test",
  } satisfies Chat["work"];
  const expired = createPage(work);
  transport.send.mockResolvedValueOnce(createChat({ kind: "ready" }));
  await invokePage(expired, "retry");
  expect(transport.send).toHaveBeenCalledWith("organisation_test", {
    kind: "retry",
    conversationId: requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    requestId: "request_test",
    model: "test-model",
    effort: "medium",
  });
  const live = createPage({ ...work, expiresAt: Date.now() + 60_000 });
  await invokePage(live, "retry");
  expect(transport.send).toHaveBeenCalledTimes(1);
});

it("reuses the accepted cancellation identity when retrying stop", async function retriesCancellation() {
  const page = createPage({
    kind: "cancelling",
    requestId: "request_test",
    cancellationId: "cancel_test",
    expiresAt: 1,
    sessionId: "session_test",
    turnId: "turn_test",
  });
  transport.cancel.mockResolvedValueOnce(createChat({ kind: "ready" }));
  await invokePage(page, "stop");
  expect(transport.cancel).toHaveBeenCalledWith("organisation_test", {
    conversationId: requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    requestId: "request_test",
    cancellationId: "cancel_test",
    sessionId: "session_test",
    turnId: "turn_test",
  });
  expect(page.state.page).toMatchObject({
    data: { conversation: { work: { kind: "ready" } } },
  });
});

function createChat(work: Chat["work"]): Chat {
  return {
    sharing: { visibility: "private", role: "owner" },
    lineage: { kind: "original" },
    origin: null,
    forkableResponseIds: [],
    id: requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    title: "Test chat",
    revision: 1,
    model: "test-model",
    effort: "medium",
    messages: [],
    timeline: [],
    latestSequence: 0,
    lastReadSequence: 0,
    draft: { text: "", updatedAt: null },
    pendingInputs: [],
    work,
    lifecycle: "active",
    pinnedAt: null,
    projectContext: null,
    placement: {
      projectId: requireProjectId(
        "project_00000000-0000-4000-8000-00000000ba5e",
      ),
      membershipRevision: 1,
      position: 0,
    },
  };
}

function createPage(work: Chat["work"]): ChatPage {
  const page = new ChatPage({
    close: vi.fn(),
    organisationId: "organisation_test",
    basePath: "/chat",
    integrationsPath: "/integrations",
    accessPath: "/access",
    canManage: true,
  });
  Reflect.set(page, "mounted", true);
  page.state = {
    ...page.state,
    selectedModel: "test-model",
    selectedEffort: "medium",
    page: { kind: "ready", data: pageData(createChat(work)) },
  };
  page.setState = applyPageState;
  return page;
}

function pageData(conversation: Chat): Awaited<ReturnType<typeof readChat>> {
  return {
    model: {
      kind: "ready",
      agent: "Pi",
      selected: "test-model",
      name: "Test model",
      options: [],
    },
    configurationVersion: 1,
    projectDirectory: {
      revision: 0,
      defaultProjectId: requireProjectId("project_00000000-0000-4000-8000-00000000ba5e"),
      projects: [],
      placements: [],
    },
    derivedThreads: [],
    pinnedConversations: [],
    pendingDeletions: [],
    nextActiveCursor: null,
    nextArchivedCursor: null,
    unreadCount: 0,
    conversations: [],
    archivedConversations: [],
    conversation,
    emailReview: { replies: [], operational: [] },
    slackDrafts: [],
    configurationDrafts: [],
    sideCases: [],
    sideCaseSource: null,
  };
}

function applyPageState(
  this: ChatPage,
  update: Parameters<ChatPage["setState"]>[0],
  callback?: () => void,
): void {
  const change =
    typeof update === "function" ? update(this.state, this.props) : update;
  this.state = { ...this.state, ...change };
  callback?.();
}

function editDraft(page: ChatPage, text: string): void {
  page.state = { ...page.state, draft: text };
  Reflect.set(page, "draftDirty", true);
}

function invokePage(page: ChatPage, name: string, ...args: unknown[]): unknown {
  return Reflect.apply(Reflect.get(page, name), page, args);
}
