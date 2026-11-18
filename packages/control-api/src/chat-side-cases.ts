import { isNonNegativeInteger, isRecord } from "@seams/std";
import { isConversationId, type ConversationId } from "./ids.ts";

/**
 * A side Case that an agent proposed in a Portal chat (Plan 74). The card
 * shows in the chat where the agent proposed it. A person starts it as a new
 * chat, or dismisses it.
 */
export type ChatSideCaseView = Readonly<{
  proposalId: string;
  title: string;
  brief: string;
  createdAt: number;
  state: ChatSideCaseState;
}>;

export type ChatSideCaseState =
  /** `mayDecide` is false for a person who may only view the chat. */
  | Readonly<{ kind: "open"; expiresAt: number; mayDecide: boolean }>
  /** The person who started it may start it again to finish the start. */
  | Readonly<{ kind: "starting"; mayRetry: boolean }>
  /** The new chat, when this person may open it. */
  | Readonly<{ kind: "started"; conversationId: ConversationId | null }>
  | Readonly<{ kind: "dismissed" }>
  | Readonly<{ kind: "expired" }>;

/** Where a side Case chat came from, as its reader may see it. */
export type ChatSideCaseSource =
  | Readonly<{
      kind: "available";
      conversationId: ConversationId;
      title: string;
    }>
  /** The source chat was deleted, or this person cannot open it. */
  | Readonly<{ kind: "unavailable" }>;

export const SIDE_CASE_TITLE_MAX_LENGTH = 80;
export const SIDE_CASE_BRIEF_MAX_LENGTH = 2_000;

/** One accepted brief per proposal, including retries from a new browser. */
export function sideCaseHereRequestId(proposalId: string): string {
  return `side_case_here_${proposalId}`;
}

export function isSideCaseProposalId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

export function parseChatSideCaseViews(
  raw: unknown,
): readonly ChatSideCaseView[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const views: ChatSideCaseView[] = [];
  for (const item of raw) {
    const view = parseChatSideCaseView(item);
    if (view === null) return null;
    views.push(view);
  }
  return views;
}

export function parseChatSideCaseView(raw: unknown): ChatSideCaseView | null {
  if (
    !isRecord(raw) ||
    !isSideCaseProposalId(raw.proposalId) ||
    typeof raw.title !== "string" ||
    raw.title.length === 0 ||
    raw.title.length > SIDE_CASE_TITLE_MAX_LENGTH ||
    typeof raw.brief !== "string" ||
    raw.brief.length === 0 ||
    raw.brief.length > SIDE_CASE_BRIEF_MAX_LENGTH ||
    !isNonNegativeInteger(raw.createdAt)
  )
    return null;
  const state = parseState(raw.state);
  if (state === null) return null;
  return {
    proposalId: raw.proposalId,
    title: raw.title,
    brief: raw.brief,
    createdAt: raw.createdAt,
    state,
  };
}

export function parseChatSideCaseSource(
  raw: unknown,
): ChatSideCaseSource | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  if (
    raw.kind === "available" &&
    isConversationId(raw.conversationId) &&
    typeof raw.title === "string"
  )
    return {
      kind: "available",
      conversationId: raw.conversationId,
      title: raw.title,
    };
  return null;
}

function parseState(raw: unknown): ChatSideCaseState | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "open":
      return isNonNegativeInteger(raw.expiresAt) &&
        typeof raw.mayDecide === "boolean"
        ? { kind: "open", expiresAt: raw.expiresAt, mayDecide: raw.mayDecide }
        : null;
    case "starting":
      return typeof raw.mayRetry === "boolean"
        ? { kind: "starting", mayRetry: raw.mayRetry }
        : null;
    case "started":
      return raw.conversationId === null || isConversationId(raw.conversationId)
        ? { kind: "started", conversationId: raw.conversationId }
        : null;
    case "dismissed":
      return { kind: "dismissed" };
    case "expired":
      return { kind: "expired" };
    default:
      return null;
  }
}
