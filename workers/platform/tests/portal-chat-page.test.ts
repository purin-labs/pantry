import { requireConversationId, requireProjectId } from "./test-ids";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ChatDraftConflictError,
  type saveChatDraft,
  type readChat,
} from "@purin-labs/surface-portal/ui/features/chat/api";
import type { Chat } from "@purin-labs/control-api/portal/chat";
// @ts-expect-error The portal build type-checks JSX separately from platform tests.
import { ChatPage } from "@purin-labs/surface-portal/ui/features/chat/route";

const transport = vi.hoisted(function createTransport() {
  return {
    save: vi.fn<typeof saveChatDraft>(),
    read: vi.fn<typeof readChat>(),
  };
});

vi.mock("@purin-labs/surface-portal/ui/features/chat/api", mockChatApi);

async function mockChatApi(importOriginal: () => Promise<object>) {
  return {
    ...(await importOriginal()),
    saveChatDraft: transport.save,
    readChat: transport.read,
  };
}

beforeEach(function setup() {
  vi.resetAllMocks();
  vi.stubGlobal("document", { removeEventListener: vi.fn() });
  vi.stubGlobal("window", {
    location: {
      search: "?conversation=conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    },
    clearTimeout,
    setTimeout,
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), speak: vi.fn() });
});

afterEach(function cleanup() {
  vi.unstubAllGlobals();
});

it("returns a draft that a navigation flush could not save when its chat opens again", async function keepsConflictingDraft() {
  const page = createPage({ kind: "ready" });
  const firstId = requireConversationId(
    "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
  );
  const otherId = requireConversationId(
    "conv_2b1c4e6a-0f3d-5a8b-9c7e-1d2f3a4b5c6d",
  );
  editDraft(page, "Unsaved local text");
  transport.save.mockRejectedValueOnce(
    new ChatDraftConflictError("Other window", 2, 10),
  );
  transport.read.mockResolvedValueOnce(
    pageData({ ...createChat({ kind: "ready" }), id: otherId }),
  );
  await invokePage(page, "selectThread", otherId, false);
  expect(page.state.page).toMatchObject({
    data: { conversation: { id: otherId } },
  });
  expect(page.state.draft).toBe("");

  transport.read.mockResolvedValueOnce(
    pageData({
      ...createChat({ kind: "ready" }),
      draft: { text: "Other window", updatedAt: 10 },
    }),
  );
  await invokePage(page, "selectThread", firstId, false);
  expect(page.state.page).toMatchObject({
    data: { conversation: { id: firstId } },
  });
  expect(page.state.draft).toBe("Unsaved local text");
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
      defaultProjectId: requireProjectId(
        "project_00000000-0000-4000-8000-00000000ba5e",
      ),
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
