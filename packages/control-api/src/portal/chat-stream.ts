import type { PortalChatStreamRecord as ChatStreamRecord } from "@purin-labs/contracts";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";

export function parseChatStreamRecord(raw: unknown): ChatStreamRecord {
  if (
    !isRecord(raw) ||
    typeof raw.sequence !== "number" ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 0
  )
    throw new Error("The response stream returned an invalid event.");
  switch (raw.kind) {
    case "assistant_text_delta":
      if (typeof raw.text === "string" && raw.text.length > 0)
        return {
          kind: "assistant_text_delta",
          sequence: raw.sequence,
          text: raw.text,
        };
      break;
    case "progress":
      if (typeof raw.label === "string" && raw.label.length > 0)
        return { kind: "progress", sequence: raw.sequence, label: raw.label };
      break;
    case "run_state":
      if (
        raw.run === "running" ||
        raw.run === "cancelling" ||
        raw.run === "ready" ||
        raw.run === "failed"
      )
        return { kind: "run_state", sequence: raw.sequence, run: raw.run };
      break;
    case "usage":
      if (
        isNonNegativeInteger(raw.inputTokens) &&
        isNonNegativeInteger(raw.outputTokens) &&
        isNonNegativeInteger(raw.totalTokens) &&
        (raw.cachedInputTokens === null ||
          isNonNegativeInteger(raw.cachedInputTokens))
      )
        return {
          kind: "usage",
          sequence: raw.sequence,
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          cachedInputTokens: raw.cachedInputTokens,
          totalTokens: raw.totalTokens,
        };
      break;
    case "complete":
      if (isNonNegativeInteger(raw.conversationRevision))
        return {
          kind: "complete",
          sequence: raw.sequence,
          conversationRevision: raw.conversationRevision,
        };
      break;
    case "paused":
      if (raw.run === "awaiting_permission")
        return {
          kind: "paused",
          sequence: raw.sequence,
          run: raw.run,
        };
      break;
    case "failed":
      if (typeof raw.message === "string" && raw.message.length > 0)
        return {
          kind: "failed",
          sequence: raw.sequence,
          message: raw.message,
          ...(isRecord(raw.failure) &&
          typeof raw.failure.code === "string" &&
          typeof raw.failure.retryable === "boolean"
            ? {
                failure: {
                  code: raw.failure.code,
                  retryable: raw.failure.retryable,
                },
              }
            : {}),
        };
      break;
  }
  throw new Error("The response stream returned an invalid event.");
}
