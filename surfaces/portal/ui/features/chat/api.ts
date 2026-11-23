import { parseSlackDrafts } from "@purin-labs/control-api/portal/slack-drafts";
import { parseConfigurationDrafts } from "@purin-labs/control-api/portal/configuration-drafts";
import type { ChatPermissionDecision } from "@purin-labs/control-api";
import type { ChatInputMode, SurfaceObservationV2 } from "@purin-labs/control-api";
import {
  ControlApiError,
  controlRead,
  controlUpload,
  controlWrite,
  readCookie,
} from "@purin-labs/control/portal/control-client";
import { isConversationId } from "@purin-labs/control-api";
import type { ConversationId, ProjectId } from "@purin-labs/control-api";
import {
  parseChatSideCaseSource,
  parseChatSideCaseViews,
  type ChatSideCaseSource,
  type ChatSideCaseView,
} from "@purin-labs/control-api";
import { parseProjectDirectory, parseProjectContent, type ProjectReference, parseProjectCaseEntries, parseProjectCatalogue, type ChatDirectoryCommand, type ProjectCaseEntry, type ProjectCommand } from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import { parseEmailReviewQueue } from "@purin-labs/control-api/portal/email-review";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type { ChatEffort } from "@purin-labs/control-api";
import { type Chat, type ChatConversationSummary, type ChatPageData, type ChatWork, parseChat, parseChatModelOptions, parseChatSummary, parseChatWork, parseDerivedThreads, parsePendingChatDeletions, parsePinnedConversations } from "@purin-labs/control-api/portal/chat";

declare const document: Readonly<{ cookie: string }>;

export class ChatAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatAccessError";
  }
}

/** The turn ended before this request arrived. The message can start a new turn. */
export class ChatNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatNotRunningError";
  }
}

export class ChatDraftConflictError extends Error {
  readonly code = "chat_revision_conflict";
  readonly serverDraft: string;
  readonly serverRevision: number;
  readonly serverUpdatedAt: number | null;

  constructor(
    serverDraft: string,
    serverRevision: number,
    serverUpdatedAt: number | null,
  ) {
    super("This draft changed in another window.");
    this.name = "ChatDraftConflictError";
    this.serverDraft = serverDraft;
    this.serverRevision = serverRevision;
    this.serverUpdatedAt = serverUpdatedAt;
  }
}

export async function readChat(
  organisationId: string,
  conversationId: ConversationId | null,
  search = "",
  mode: "reconnect" | "observe" = "reconnect",
  cursors: Readonly<{ active: string | null; archived: string | null }> = {
    active: null,
    archived: null,
  },
): Promise<ChatPageData> {
  const params = new URLSearchParams();
  if (cursors.active !== null) params.set("activeAfter", cursors.active);
  if (cursors.archived !== null) params.set("archivedAfter", cursors.archived);
  if (conversationId !== null) params.set("conversation", conversationId);
  if (search.length > 0) params.set("search", search);
  if (mode === "observe") params.set("observe", "true");
  const query = params.toString().length === 0 ? "" : `?${params.toString()}`;
  const raw = await chatRequest(`${chatPath(organisationId)}${query}`, {
  });
  if (
    !isRecord(raw.model) ||
    !Array.isArray(raw.conversations) ||
    !Array.isArray(raw.archivedConversations) ||
    !Array.isArray(raw.emailReviews) ||
    typeof raw.configurationVersion !== "number" ||
    typeof raw.unreadCount !== "number" ||
    !Number.isSafeInteger(raw.unreadCount) ||
    raw.unreadCount < 0
  )
    throw new Error("Could not read the conversation.");
  const conversations: ChatPageData["conversations"][number][] = [];
  for (const item of raw.conversations) {
    const summary = parseChatSummary(item);
    if (summary.lifecycle !== "active")
      throw new Error("Invalid active conversation list.");
    conversations.push(summary);
  }
  const archivedConversations: ChatPageData["archivedConversations"][number][] =
    [];
  for (const item of raw.archivedConversations) {
    const summary = parseChatSummary(item);
    if (summary.lifecycle !== "archived")
      throw new Error("Invalid archived conversation list.");
    archivedConversations.push(summary);
  }
  let model: ChatPageData["model"];
  if (
    raw.model.kind === "ready" &&
    typeof raw.model.selected === "string" &&
    (raw.model.agent === "Pi" || raw.model.agent === "Claude") &&
    typeof raw.model.name === "string" &&
    Array.isArray(raw.model.options)
  )
    model = {
      kind: "ready",
      selected: raw.model.selected,
      agent: raw.model.agent,
      name: raw.model.name,
      options: parseChatModelOptions(raw.model.options),
    };
  else if (
    raw.model.kind === "unavailable" &&
    typeof raw.model.message === "string"
  )
    model = { kind: "unavailable", message: raw.model.message };
  else throw new Error("Could not read the AI connection.");
  const projectDirectory = parseProjectDirectory(raw.projectDirectory);
  if (projectDirectory === null)
    throw new Error("Could not read chat projects.");
  return {
    model,
    configurationVersion: raw.configurationVersion,
    unreadCount: raw.unreadCount,
    projectDirectory,
    pendingDeletions: parsePendingChatDeletions(raw.pendingDeletions),
    derivedThreads: parseDerivedThreads(raw.derivedThreads),
    pinnedConversations: parsePinnedConversations(raw.pinnedConversations),
    nextActiveCursor:
      typeof raw.nextActiveCursor === "string" ? raw.nextActiveCursor : null,
    nextArchivedCursor:
      typeof raw.nextArchivedCursor === "string"
        ? raw.nextArchivedCursor
        : null,
    conversations,
    archivedConversations,
    conversation:
      raw.conversation === null ? null : parseChat(raw.conversation),
    emailReview: parseEmailReviewQueue(raw.emailReviews),
    slackDrafts: parseSlackDrafts(raw.slackDrafts),
    configurationDrafts: parseConfigurationDrafts(raw.configurationDrafts),
    sideCases: requireSideCases(raw.sideCases),
    sideCaseSource:
      raw.sideCaseSource === undefined || raw.sideCaseSource === null
        ? null
        : requireSideCaseSource(raw.sideCaseSource),
  };
}

function requireSideCases(raw: unknown): readonly ChatSideCaseView[] {
  const views = parseChatSideCaseViews(raw);
  if (views === null) throw new Error("The server returned invalid side Cases.");
  return views;
}

function requireSideCaseSource(raw: unknown): ChatSideCaseSource {
  const source = parseChatSideCaseSource(raw);
  if (source === null)
    throw new Error("The server returned an invalid side Case source.");
  return source;
}

export async function updateChatConversation(
  organisationId: string,
  conversationId: ConversationId,
  action:
    | "pin"
    | "unpin"
    | {
        readonly kind: "archive" | "restore";
        readonly expectedRevision: number;
      }
    | {
        readonly kind: "rename";
        readonly title: string;
        readonly expectedRevision: number;
      },
): Promise<ChatConversationSummary> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to update this chat.");
  const raw = await chatRequest(
    chatConversationPath(organisationId, conversationId),
    {
      method: "PATCH",
      json:
        typeof action === "string"
          ? { action }
          : {
              action: action.kind,
              ...(action.kind === "rename" ? { title: action.title } : {}),
              expectedRevision: action.expectedRevision,
            },
    },
  );
  return parseChatSummary(raw.conversation);
}

export async function rateChatResponse(
  organisationId: string,
  conversationId: ConversationId,
  eventId: string,
  rating: "good" | "bad" | null,
): Promise<void> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to save feedback.");
  const raw = await chatRequest(
    chatConversationPath(organisationId, conversationId),
    {
      method: "PATCH",
      json: { action: "rate_response", eventId, rating },
    },
  );
  if (raw.rating !== rating)
    throw new Error("Could not save response feedback.");
}

export async function saveChatDraft(
  organisationId: string,
  conversationId: ConversationId,
  draft: string,
  expectedUpdatedAt: number | null,
): Promise<{
  readonly revision: number;
  readonly draft: string;
  readonly updatedAt: number | null;
}> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to save this draft.");
  const raw = await chatRequest(chatDraftPath(organisationId, conversationId), {
    method: "PUT",
    json: { draft, expectedUpdatedAt },
  });
  if (
    !isRecord(raw.draft) ||
    typeof raw.draft.revision !== "number" ||
    typeof raw.draft.draft !== "string" ||
    (raw.draft.updatedAt !== null && typeof raw.draft.updatedAt !== "number")
  )
    throw new Error("Could not save the draft.");
  return {
    revision: raw.draft.revision,
    draft: raw.draft.draft,
    updatedAt: raw.draft.updatedAt,
  };
}

export async function markChatRead(
  organisationId: string,
  conversationId: ConversationId,
  sequence: number,
): Promise<void> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to mark chat read.");
  await chatRequest(chatReadPath(organisationId, conversationId), {
    method: "POST",
    json: { sequence },
  });
}

export async function cancelChat(
  organisationId: string,
  input: {
    readonly conversationId: ConversationId;
    readonly requestId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly cancellationId: string;
  },
): Promise<Chat> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to stop this response.");
  const raw = await chatRequest(chatCancelPath(organisationId), {
    method: "POST",
    json: input,
  });
  return parseChat(raw.conversation);
}

/** Resumes or stops a run that paused for a permission. */
export async function decideChatPermission(
  organisationId: string,
  conversationId: ConversationId,
  permissionRequestId: string,
  decision: ChatPermissionDecision,
): Promise<Chat> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to answer this request.");
  const raw = await chatRequest(
    `${chatConversationPath(organisationId, conversationId)}/permission`,
    {
      method: "POST",
      json: { permissionRequestId, decision },
    },
  );
  return parseChat(raw.conversation);
}

/** A command that the chat composer sends. */
export type ChatCommand =
  | {
      readonly kind: "message";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly model: string;
      readonly text: string;
      readonly browserContext: BakeryBrowserContext;
      readonly effort?: ChatEffort;
      readonly inputMode?: ChatInputMode;
      readonly goalTokenBudget?: number;
    }
  | {
      readonly kind: "steer";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly inputId: string;
      readonly cancellationId: string;
      readonly model: string;
      readonly text: string;
      readonly browserContext: BakeryBrowserContext;
      readonly effort?: ChatEffort;
      readonly inputMode?: ChatInputMode;
    }
  | {
      readonly kind: "next";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly inputId: string;
      readonly model: string;
      readonly text: string;
      readonly browserContext: BakeryBrowserContext;
      readonly effort?: ChatEffort;
      readonly inputMode?: ChatInputMode;
    }
  | {
      readonly kind: "withdraw";
      readonly conversationId: ConversationId;
      readonly inputId: string;
    }
  | {
      readonly kind: "steer_queued";
      readonly conversationId: ConversationId;
      readonly inputId: string;
      readonly cancellationId: string;
      readonly model: string;
    }
  | {
      readonly kind: "retry";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly model: string;
      readonly effort?: ChatEffort;
    };

/**
 * Posts a chat command as it is. `sendChat` in `./send` adds the page on the
 * screen first; this module reads no browser state, so the Platform tests can
 * compile it without the DOM.
 */
export async function postChatCommand(
  organisationId: string,
  body: ChatCommand & { readonly surfaceObservation?: SurfaceObservationV2 },
  files: readonly File[] = [],
): Promise<Chat> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null)
    throw new Error("Sign in again to continue this conversation.");
  const form = new FormData();
  form.set("command", JSON.stringify(body));
  for (const file of files) form.append("files", file, file.name);
  const raw = await chatRequest(
    chatPath(organisationId),
    files.length === 0 ? { method: "POST", json: body } : { method: "POST", form },
  );
  return parseChat(raw.conversation);
}

function chatPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat`;
}

function chatConversationPath(
  organisationId: string,
  conversationId: ConversationId,
): string {
  return `${chatPath(organisationId)}/conversations/${encodeURIComponent(conversationId)}`;
}

function chatDraftPath(organisationId: string, conversationId: ConversationId): string {
  return `${chatConversationPath(organisationId, conversationId)}/draft`;
}

function chatReadPath(organisationId: string, conversationId: ConversationId): string {
  return `${chatConversationPath(organisationId, conversationId)}/read`;
}

function chatCancelPath(organisationId: string): string {
  return `${chatPath(organisationId)}/cancel`;
}

/** A chat request: a read without a method, a JSON write, or a message with files. */
type ChatRequestInit = Readonly<{
  method?: "DELETE" | "PATCH" | "POST" | "PUT";
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}>;

async function chatRequest(
  path: string,
  init: ChatRequestInit = {},
): Promise<Record<string, unknown>> {
  let raw: unknown;
  let status: number | null = null;
  try {
    raw = await (init.method === undefined
      ? controlRead(path, init.signal)
      : init.form !== undefined
        ? controlUpload(path, init.form, `portal-${crypto.randomUUID()}`)
        : controlWrite(path, init.method, init.json, init.signal));
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    if (error.details === null)
      throw new Error(
        error.status === null
          ? "The server returned an unreadable chat response. Refresh to check the saved conversation."
          : `The chat request was interrupted (HTTP ${error.status}). Checking the saved conversation; retry the response when available.`,
      );
    raw = error.details;
    status = error.status;
  }
  if (!isRecord(raw)) throw new Error("Could not read the chat response.");
  if (status !== null) {
    if (status === 401 || status === 403 || status === 404)
      throw new ChatAccessError(typeof raw.message === "string" ? raw.message : "This chat is no longer available to your account.");
    if (
      raw.error === "chat_revision_conflict" &&
      typeof raw.draft === "string" &&
      isNonNegativeInteger(raw.revision) &&
      (raw.updatedAt === null || isNonNegativeInteger(raw.updatedAt))
    )
      throw new ChatDraftConflictError(raw.draft, raw.revision, raw.updatedAt);
    if (raw.error === "chat_not_running" && typeof raw.message === "string")
      throw new ChatNotRunningError(raw.message);
    throw new Error(
      typeof raw.message === "string"
        ? raw.message
        : `Could not load chat (HTTP ${status}${typeof raw.error === "string" ? `: ${raw.error}` : ""}). Try again.`,
    );
  }
  return raw;
}

export async function readChatStatus(
  organisationId: string,
  conversationId: ConversationId,
  signal: AbortSignal,
): Promise<{ readonly revision: number; readonly work: ChatWork }> {
  const query = new URLSearchParams({
    conversation: conversationId,
    view: "state",
  });
  const raw = await chatRequest(`${chatPath(organisationId)}?${query}`, {
    signal,
  });
  if (
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1
  )
    throw new Error("Invalid conversation revision.");
  return { revision: raw.revision, work: parseChatWork(raw.work) };
}

// The member's own sidebar: Project order and where their chats sit.
export async function mutateChatDirectory(
  organisationId: string,
  command: ChatDirectoryCommand,
): Promise<void> {
  const result = await projectCommand(
    `${chatPath(organisationId)}/projects`,
    command,
  );
  if (result.kind === "accepted") return;
  throw new Error(
    result.code === "chat_running"
      ? "A turn is running. Move this chat after it finishes."
      : result.code === "chat_work_unfinished"
        ? UNFINISHED_WORK_MESSAGE
        : "The chat order changed in another window. Refresh and try again.",
  );
}

// A failed turn and a queued message keep the project context they were
// accepted with, so the chat stays where it is until they are dealt with.
export const UNFINISHED_WORK_MESSAGE =
  "This chat has a failed response or queued messages. Retry the response or remove the queued messages, then move it.";

function projectsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/projects`;
}

// A general Project or Case command. A refusal comes back as a result, so
// the caller can say why.
async function projectCommand(
  path: string,
  command: unknown,
): Promise<Record<string, unknown>> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to change projects.");
  let raw: unknown = null;
  let status = 200;
  try {
    raw = await controlWrite(path, "POST", command);
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    raw = error.details;
    status = error.status ?? 200;
    // A 409 that rejects the command is its answer; any other refusal is not.
    if (!(status === 409 && isRecord(raw) && raw.kind === "rejected"))
      raw = null;
  }
  if (isRecord(raw)) return raw;
  throw new Error(
    `The project request did not finish (HTTP ${status}). Refresh and try again.`,
  );
}

// Project content, deletion and the default Project, for every surface.
export async function mutateProject(
  organisationId: string,
  command: ProjectCommand,
): Promise<void> {
  const result = await projectCommand(projectsPath(organisationId), command);
  if (result.kind !== "accepted")
    throw new Error(projectRejectionMessage(result.code));
}

// Later work with no named Project goes to this one. Nothing already filed moves.
export async function makeDefaultProject(
  organisationId: string,
  projectId: ProjectId,
): Promise<void> {
  const catalogue = parseProjectCatalogue(
    await chatRequest(projectsPath(organisationId), {
    }),
  );
  if (catalogue === null) throw new Error("Could not read the projects.");
  await mutateProject(organisationId, {
    kind: "set_default_project",
    operationId: crypto.randomUUID(),
    projectId,
    expectedDefaultRevision: catalogue.defaultProject.revision,
  });
}

// The work filed in a Project that this reader may know of.
export async function readProjectCases(
  organisationId: string,
  projectId: ProjectId,
): Promise<readonly ProjectCaseEntry[]> {
  const raw = await chatRequest(
    `${projectsPath(organisationId)}/${encodeURIComponent(projectId)}/cases`,
  );
  const cases = parseProjectCaseEntries(raw.cases);
  if (cases === null) throw new Error("Could not read this project's work.");
  return cases;
}

export async function moveCaseToProject(
  organisationId: string,
  entry: ProjectCaseEntry,
  projectId: ProjectId,
): Promise<void> {
  const result = await projectCommand(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/cases/${encodeURIComponent(entry.caseId)}/project`,
    {
      kind: "move_case",
      operationId: crypto.randomUUID(),
      expectedRevision: entry.revision,
      projectId,
    },
  );
  if (result.kind === "accepted") return;
  throw new Error(
    result.code === "case_destination_unavailable"
      ? "This work can only move to a shared project you can edit, or to the default project."
      : result.code === "case_running"
        ? "This chat is running. Move it when the response finishes."
        : result.code === "case_work_unfinished"
          ? UNFINISHED_WORK_MESSAGE
          : "This work changed in another window, so it was not moved.",
  );
}

function projectRejectionMessage(code: unknown): string {
  switch (code) {
    case "project_is_default":
      return "This is the default project. Make another project the default before deleting it.";
    case "project_contains_shared_chats":
      return "Move or delete the shared chats in this project first.";
    case "project_contains_cases":
      return "Move the Slack, email and other work filed in this project first.";
    case "default_project_ineligible":
      return "Only a shared project you own can be the default, and only an administrator can choose it.";
    default:
      return "This project changed in another window. Refresh and try again.";
  }
}

export async function permanentlyDeleteChat(
  organisationId: string,
  conversationId: ConversationId,
  expectedRevision: number,
  operationId: string,
): Promise<void> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to delete chats.");
  await chatRequest(chatConversationPath(organisationId, conversationId), {
    method: "PATCH",
    json: { action: "delete", expectedRevision, operationId },
  });
}

export async function readProjectReferences(
  organisationId: string,
  query: string,
): Promise<readonly ProjectReference[]> {
  const raw = await chatRequest(
    `${projectsPath(organisationId)}/references?${new URLSearchParams({ search: query })}`,
  );
  const parsed = parseProjectContent({
    name: "References",
    brief: "",
    references: raw.references,
  });
  if (parsed === null) throw new Error("Could not read workspace references.");
  return parsed.references;
}

export async function createProjectChat(
  organisationId: string,
  projectId: ProjectId,
  conversationId: ConversationId,
): Promise<ConversationId> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to start a project chat.");
  const raw = await chatRequest(`${chatPath(organisationId)}/projects/chats`, {
    method: "POST",
    json: { projectId, conversationId },
  });
  if (raw.conversationId !== conversationId)
    throw new Error("Could not start this chat.");
  return conversationId;
}

export async function forkChatThread(organisationId: string, sourceId: ConversationId, messageId: string, operationId: string): Promise<ConversationId> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to fork this chat.");
  const raw = await chatRequest(chatConversationPath(organisationId, sourceId), { method: "PATCH", json: { action: "fork", messageId, operationId } });
  if (raw.kind !== "ready" || !isConversationId(raw.conversationId)) throw new Error("The fork is still preparing. Retry to recover the same chat.");
  return raw.conversationId;
}
