import React from "react";
import type { ChatStreamState } from "./delivery";
import type { PageState } from "./page-state";

/**
 * The request that the person's own chat runs now (Plan 40B phase 7, slice
 * 6), for the page beside the chat: the board's presence bar shows the
 * agent's latest line of text and Stop only to the person who asked. The
 * chat publishes it after each change; the Session ID matches the agent's
 * Session in a board room's presence. Stop is the chat's own Cancel, with
 * its checks and its receipt. Nothing here leaves the person's browser.
 */
type ChatAgentRequest = Readonly<{
  sessionId: string;
  latestLine: string | null;
  stopping: boolean;
  stop: () => void;
}>;

let current: ChatAgentRequest | null = null;
const listeners = new Set<() => void>();

/** Called by the chat after each change of its page or its stream. */
export function publishChatAgentRequest(
  state: Readonly<{ page: PageState; stream: ChatStreamState }>,
  stop: () => void,
): void {
  const work = state.page.kind === "ready" ? state.page.data.conversation?.work ?? null : null;
  const next = work === null || (work.kind !== "running" && work.kind !== "cancelling")
    ? null
    : {
        sessionId: work.sessionId,
        latestLine: latestLine(state.stream, work.requestId),
        stopping: work.kind === "cancelling",
        stop,
      };
  if (
    next?.sessionId === current?.sessionId &&
    next?.latestLine === current?.latestLine &&
    next?.stopping === current?.stopping
  )
    return;
  current = next;
  for (const listener of listeners) listener();
}

/** The person's running chat request, or null. */
export function useChatAgentRequest(): ChatAgentRequest | null {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ChatAgentRequest | null {
  return current;
}

/** The last line of the answer that streams now, at most 160 characters. */
function latestLine(stream: ChatStreamState, requestId: string): string | null {
  if ((stream.kind !== "active" && stream.kind !== "reconnecting") || stream.requestId !== requestId) return null;
  const line = stream.text.split("\n").map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  if (line.length === 0) return stream.progress;
  return line.length > 160 ? `…${line.slice(-159)}` : line;
}
