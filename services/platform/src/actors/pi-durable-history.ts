import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";
import type {
  HarnessHistoryEntry,
  HarnessHistoryContent,
  AcceptedInputRef,
} from "@purin-labs/contracts";
import { isRecord, canonicalJson } from "@purin-labs/std";
import { materializeAssistantHistoryContent } from "./pi-history-adapter";
import { parseHarnessHistoryEntry } from "./harness-history";

export function canonicalFact(
  message: Message,
  turn: HarnessHistoryEntry["turn"],
  input: AcceptedInputRef,
  userContent: readonly HarnessHistoryContent[] | null,
): HarnessHistoryEntry | null {
  const entry = nativeHistoryEntry(message, turn, input, userContent);
  if (entry === null) return null;
  const parsed = parseHarnessHistoryEntry(
    JSON.parse(canonicalJson({ version: 1, entry })),
  );
  if (parsed === null) throw new Error("Invalid native history entry");
  return parsed;
}

/**
 * A turn the platform stops before the model replies still ends with the
 * notice its user receives, so the accepted history has a completed boundary.
 */
export function canonicalStopNotice(
  text: string,
  model: string,
  turn: HarnessHistoryEntry["turn"],
  acceptedAt: number,
): HarnessHistoryEntry {
  return {
    kind: "assistant_message",
    turn,
    model,
    content: [{ kind: "text", text, continuation: { kind: "none" } }],
    stopReason: "completed",
    usage: {
      modelCalls: 0,
      callsWithUsage: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    acceptedAt,
  };
}
function nativeHistoryEntry(
  message: Message,
  turn: HarnessHistoryEntry["turn"],
  input: AcceptedInputRef,
  userContent: readonly HarnessHistoryContent[] | null,
) {
  const acceptedAt = Date.now();
  if (message.role === "user")
    return {
      kind: "user_input",
      turn,
      input,
      content: userContent ?? [
        {
          kind: "text",
          text:
            typeof message.content === "string"
              ? message.content
              : message.content.map(textContent).join(""),
        },
      ],
      acceptedAt,
    };
  if (message.role === "toolResult") {
    const authority = isRecord(message.details)
      ? message.details.satyrAuthority
      : undefined;
    if (!isRecord(authority))
      throw new Error("Tool result requires trusted authority");
    return {
      kind: "tool_result",
      turn,
      callId: message.toolCallId,
      tool: message.toolName,
      outcome: {
        kind: message.isError ? "failed" : "succeeded",
        output: (isRecord(message.details)
          ? message.details.satyrOutput
          : undefined) ?? {
          kind: "inline",
          content: [
            { kind: "text", text: message.content.map(textContent).join("") },
          ],
          digest: authority.resultDigest,
        },
      },
      authority,
      acceptedAt,
    };
  }
  if (message.role !== "assistant") return null;
  if (
    message.stopReason !== "stop" &&
    message.stopReason !== "toolUse" &&
    message.stopReason !== "length"
  )
    throw new Error("Unsupported provider stop reason");
  const usage = message.usage;
  return {
    kind: "assistant_message",
    turn,
    model: message.model,
    content: materializeAssistantHistoryContent(message.content, message),
    stopReason:
      message.stopReason === "toolUse"
        ? "tool_use"
        : message.stopReason === "length"
          ? "length"
          : "completed",
    usage: {
      modelCalls: 1,
      callsWithUsage: usage ? 1 : 0,
      inputTokens: usage?.input ?? 0,
      cachedInputTokens: usage?.cacheRead ?? 0,
      outputTokens: usage?.output ?? 0,
      reasoningTokens: usage?.reasoning ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    },
    acceptedAt,
  };
}

function textContent(block: TextContent | ImageContent): string {
  return block.type === "text" ? block.text : "";
}
