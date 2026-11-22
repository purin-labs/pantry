import type { ConversationId } from "@purin-labs/control-api";
import type { PortalChatStreamRecord as ChatStreamRecord } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";
import { parseChatStreamRecord } from "@purin-labs/control-api/portal/chat-stream";
import { controlStream } from "@purin-labs/control/portal/control-client";

export type { PortalChatStreamRecord as ChatStreamRecord } from "@purin-labs/contracts";

export async function readChatStream(input: {
  readonly organisationId: string;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly afterSequence: number;
  readonly signal: AbortSignal;
  readonly accept: (record: ChatStreamRecord) => void;
}): Promise<Variant<ChatStreamRecord, "complete" | "paused" | "failed">> {
  const query = new URLSearchParams({
    conversation: input.conversationId,
    request: input.requestId,
    after: String(input.afterSequence),
  });
  const response = await controlStream(
    `/v1/control/organisations/${encodeURIComponent(input.organisationId)}/chat/stream?${query.toString()}`,
    input.signal,
  );
  if (!response.ok) throw await streamResponseError(response);
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new Error("The response stream is unavailable.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const consumed = consumeLines(buffer, input.accept);
      buffer = consumed.remaining;
      if (consumed.terminal !== null) return consumed.terminal;
      if (chunk.done) throw new Error("The response stream ended early.");
    }
  } finally {
    reader.releaseLock();
  }
}

function consumeLines(
  text: string,
  accept: (record: ChatStreamRecord) => void,
): {
  readonly remaining: string;
  readonly terminal: Variant<
    ChatStreamRecord,
    "complete" | "paused" | "failed"
  > | null;
} {
  let remaining = text;
  for (;;) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) return { remaining, terminal: null };
    const line = remaining.slice(0, newline).trim();
    remaining = remaining.slice(newline + 1);
    if (line.length === 0) continue;
    const record = parseChatStreamRecord(parseJsonOrNull(line));
    accept(record);
    if (
      record.kind === "complete" ||
      record.kind === "paused" ||
      record.kind === "failed"
    )
      return { remaining, terminal: record };
  }
}

async function streamResponseError(response: Response): Promise<Error> {
  try {
    const raw: unknown = await response.json();
    if (isRecord(raw) && typeof raw.message === "string")
      return new Error(raw.message);
  } catch {
    // Fall through to the status-based message.
  }
  return new Error(
    `The response stream could not open (HTTP ${response.status}).`,
  );
}
