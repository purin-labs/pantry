import { isConversationId } from "@purin-labs/control-api";
import {
  MESSAGE_ATTACHMENT_POLICY,
  type ConversationId,
  type ProjectId,
} from "@purin-labs/control-api";
import React from "react";
import { FileText, Paperclip } from "lucide-react";
import type {
  Chat,
  ChatConversationSummary,
  ChatPageData,
  ChatTimelineView,
  ChatAttachmentView,
} from "@purin-labs/control-api/portal/chat";
import type { ChatStreamState } from "./delivery";
import type { Variant } from "@purin-labs/type-utils";
import type {
  ChatTurnUsage,
  Project,
  ProjectReference,
} from "@purin-labs/control-api";
import type { State } from "./route";

export type ThreadPreview = {
  readonly id: ConversationId;
  readonly read: Promise<ChatPageData | null>;
  finishedAt: number | null;
};

export function threadPreviewIsFresh(preview: ThreadPreview): boolean {
  return (
    preview.finishedAt === null ||
    Date.now() - preview.finishedAt <= THREAD_PREVIEW_ANSWER_MS
  );
}
export function readNoThreadPreview(): null {
  return null;
}
/** A click on a chat with open work must run the read that reconnects it. */
export function previewOfReadyThread(data: ChatPageData | null): ChatPageData | null {
  return data?.conversation?.work.kind === "ready" ? data : null;
}

export type ChatThreadsResize = {
  readonly pointerId: number;
  readonly anchor: number;
  width: number;
  moved: boolean;
};

/** Signals that arrive within this time give one read. */
/** How long the pointer rests on a row before its read starts. */
export const THREAD_PREVIEW_REST_MS = 120;
/** How long a click may use a read that finished before it. */
const THREAD_PREVIEW_ANSWER_MS = 5_000;
export const SIGNAL_READ_DELAY_MS = 150;
/** While the signal socket is live, the page still reads this often. */
export const SIGNAL_SAFETY_READ_MS = 60_000;
export const EMPTY_DIRECTORY = {
  apps: [],
  workspaceSetup: [],
  connectedApps: [],
  onQueryChange: ignoreQuery,
};
function ignoreQuery(): void {}

export function streamAfterConversationRefresh(
  work: Chat["work"] | undefined,
  stream: ChatStreamState,
): ChatStreamState {
  if (
    work === undefined ||
    work.kind === "ready" ||
    work.kind === "failed" ||
    work.kind === "awaiting_permission"
  )
    return { kind: "idle" };
  if (stream.kind === "paused" && stream.requestId === work.requestId)
    return { kind: "idle" };
  return stream;
}

export function timelineEventHasId(eventId: string, event: ChatTimelineView): boolean {
  return event.eventId === eventId;
}
export function formatUsage(usage: ChatTurnUsage | null): string {
  if (usage === null) return "";
  return `Usage · ${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output · ${usage.totalTokens.toLocaleString()} total`;
}
export function renderOperation(text: string): React.ReactNode {
  return <li key={text}>{text}</li>;
}

/** How long a stop or a steer settles before the Portal offers Retry stop. */
export const STOP_RETRY_AFTER_MS = 6_000;

export function renderSource(url: string): React.ReactNode {
  return (
    <li key={url}>
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
    </li>
  );
}


function applyReadSequence<
  T extends { id: ConversationId; lastReadSequence: number },
>(conversationId: ConversationId, observed: number, conversation: T): T {
  if (conversation.id !== conversationId) return conversation;
  return {
    ...conversation,
    lastReadSequence: Math.max(conversation.lastReadSequence, observed),
  };
}

function applyReadSequences<
  T extends { id: ConversationId; lastReadSequence: number },
>(
  conversationId: ConversationId,
  observed: number,
  conversations: readonly T[],
): T[] {
  const updated: T[] = [];
  for (const conversation of conversations)
    updated.push(applyReadSequence(conversationId, observed, conversation));
  return updated;
}

export function applyConversationRead(
  conversationId: ConversationId,
  observed: number,
  state: State,
): Pick<State, "page"> {
  if (state.page.kind !== "ready") return { page: state.page };
  const data = state.page.data;
  return {
    page: {
      kind: "ready",
      data: {
        ...data,
        conversation:
          data.conversation === null
            ? null
            : applyReadSequence(conversationId, observed, data.conversation),
        conversations: applyReadSequences(
          conversationId,
          observed,
          data.conversations,
        ),
        archivedConversations: applyReadSequences(
          conversationId,
          observed,
          data.archivedConversations,
        ),
        pinnedConversations: applyReadSequences(
          conversationId,
          observed,
          data.pinnedConversations,
        ),
      },
    },
  };
}


export function chatWorkIsActive(work: Chat["work"] | undefined): boolean {
  return (
    work !== undefined &&
    work.kind !== "ready" &&
    work.kind !== "failed" &&
    work.kind !== "awaiting_permission" &&
    work.expiresAt > Date.now()
  );
}

export function chatWorkIsRetryable(
  work: Chat["work"] | undefined,
): work is Variant<Chat["work"], "failed" | "running"> {
  return (
    work !== undefined &&
    (work.kind === "failed" ||
      (work.kind === "running" && work.expiresAt <= Date.now()))
  );
}

export function threadSidebarStyle(
  width: number,
): React.CSSProperties & { "--chat-threads-width": string } {
  return { "--chat-threads-width": `${width}px` };
}

export function clampThreadsWidth(width: number): number {
  return Math.max(200, Math.min(500, width));
}

export function threadsWidthFromPointer(
  resize: ChatThreadsResize,
  pointerX: number,
): number {
  return pointerX - resize.anchor;
}

export function latestConversationMessage(
  events: readonly ChatTimelineView[],
): ChatTimelineView | null {
  for (const event of [...events].reverse()) {
    if (
      event.kind === "user" ||
      event.kind === "assistant" ||
      event.kind === "connector"
    )
      return event;
  }
  return null;
}

export function projectHasId(id: string, project: Project): boolean {
  return project.id === id;
}
export function chatInProject(
  projectId: ProjectId,
  conversation: ChatConversationSummary,
): boolean {
  return conversation.placement.projectId === projectId;
}
export function renderProjectReference(reference: ProjectReference): React.ReactNode {
  return (
    <li key={JSON.stringify(reference)}>
      <FileText size={16} aria-hidden="true" />
      <span>{reference.label}</span>
    </li>
  );
}

export function focusBranchPoint(messageId: string): void {
  const message = document.getElementById(`message-${messageId}`);
  message?.scrollIntoView({ block: "center" });
  message?.focus({ preventScroll: true });
}

export function summaryHasConversationId(
  id: ConversationId,
  summary: ChatConversationSummary,
): boolean {
  return summary.id === id;
}

export function initialConversationId(): ConversationId | null {
  const raw = new URLSearchParams(window.location.search).get("conversation");
  return isConversationId(raw) ? raw : null;
}

export function keepSelectedFile(removed: File, file: File): boolean {
  return file !== removed;
}
export function invalidChatFile(file: File): boolean {
  return file.size === 0 || file.size > MESSAGE_ATTACHMENT_POLICY.maxFileBytes;
}
export function totalFileBytes(total: number, file: File): number {
  return total + file.size;
}
export function chatAttachmentLimits(): string {
  return `Attach up to ${MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage} non-empty files, ${MESSAGE_ATTACHMENT_POLICY.maxFileBytes / (1024 * 1024)} MiB each and ${MESSAGE_ATTACHMENT_POLICY.maxBatchBytes / (1024 * 1024)} MiB total.`;
}

export function renderChatAttachmentPart(part: ChatAttachmentView): React.ReactNode {
  return (
    <li key={part.attachmentId}>
      <Paperclip size={14} aria-hidden="true" />
      {part.filename}
    </li>
  );
}
