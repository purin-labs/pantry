import type { ChatStreamState } from "./delivery";
import type { PageState } from "./page-state";
import { setChatAgentRequest } from "@purin-labs/collaboration/portal/agent-request";

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
  setChatAgentRequest(next);
}

/** The last line of the answer that streams now, at most 160 characters. */
function latestLine(stream: ChatStreamState, requestId: string): string | null {
  if ((stream.kind !== "active" && stream.kind !== "reconnecting") || stream.requestId !== requestId) return null;
  const line = stream.text.split("\n").map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  if (line.length === 0) return stream.progress;
  return line.length > 160 ? `…${line.slice(-159)}` : line;
}
