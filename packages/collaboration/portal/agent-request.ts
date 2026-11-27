import React from "react";

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

/** The chat sets the request after each change. A request with the same parts changes nothing. */
export function setChatAgentRequest(next: ChatAgentRequest | null): void {
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
