import type { EmbeddedHarnessUserInput } from "./embedded-harness";
import type {
  HarnessAssistantContent,
  HarnessHistoryContent,
  HarnessHistoryEntry,
  HarnessToolOutput,
} from "@seams/contracts";
import { renderHarnessHistoryContent } from "./harness-history";
import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  JsonValue,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { Variant } from "@seams/type-utils";
import { assertNever, isRecord } from "@seams/std";

export type PiMaterializedHistory = {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
};

export function materializePiHistory(input: {
  readonly systemPrompt: string;
  readonly entries: readonly HarnessHistoryEntry[];
  readonly attachments: Readonly<
    Record<string, readonly EmbeddedHarnessUserInput[]>
  >;
  readonly model: Model<string>;
}): PiMaterializedHistory | null {
  if (input.systemPrompt.trim().length === 0 || input.entries.length === 0)
    return null;
  const messages: Message[] = [];
  for (const entry of input.entries) {
    const message = materializeEntry(entry, input.model, input.attachments);
    if (message === null) return null;
    messages.push(message);
  }
  const last = messages.at(-1);
  return last?.role === "user" ||
    last?.role === "toolResult" ||
    (last?.role === "assistant" && last.stopReason !== "toolUse")
    ? { systemPrompt: input.systemPrompt, messages }
    : null;
}

function materializeEntry(
  entry: HarnessHistoryEntry,
  model: Model<string>,
  attachments: Readonly<Record<string, readonly EmbeddedHarnessUserInput[]>>,
): Message | null {
  switch (entry.kind) {
    case "user_input": {
      const content = materializeUserContent(entry.content, attachments);
      return content === null
        ? null
        : { role: "user", content, timestamp: entry.acceptedAt };
    }
    case "assistant_message": {
      const content = materializeAssistantContent(entry.content);
      if (content === null) return null;
      return {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: entry.model,
        usage: materializeUsage(entry.usage),
        stopReason: normalizeStopReason(entry.stopReason),
        timestamp: entry.acceptedAt,
      } satisfies AssistantMessage;
    }
    case "tool_result":
      return {
        role: "toolResult",
        toolCallId: entry.callId,
        toolName: entry.tool,
        content: [
          { type: "text", text: materializeToolOutput(entry.outcome.output) },
        ],
        isError: entry.outcome.kind === "failed",
        timestamp: entry.acceptedAt,
      } satisfies ToolResultMessage;
    default:
      return assertNever(entry, "unexpected history kind");
  }
}

function materializeUserContent(
  content: readonly HarnessHistoryContent[],
  attachments: Readonly<Record<string, readonly EmbeddedHarnessUserInput[]>>,
): string | (TextContent | ImageContent)[] | null {
  const parts: (TextContent | ImageContent)[] = [];
  for (const item of content) {
    if (item.kind === "text" || item.kind === "project_context")
      parts.push({ type: "text", text: item.text });
    if (item.kind === "link")
      parts.push({ type: "text", text: renderHarnessHistoryContent(item) });
    if (item.kind === "attachment") {
      const prepared = attachments[item.attachment.id];
      if (prepared === undefined) return null;
      for (const input of prepared) {
        switch (input.kind) {
          case "project_context":
          case "text":
            parts.push({ type: "text", text: input.text });
            break;
          case "image": {
            const encoded =
              /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
                input.dataUrl,
              );
            if (
              encoded === null ||
              encoded[1] === undefined ||
              encoded[2] === undefined
            )
              return null;
            parts.push({
              type: "image",
              mimeType: encoded[1],
              data: encoded[2],
            });
            break;
          }
          case "attachment_manifest":
            parts.push({ type: "text", text: input.manifest });
            break;
          case "attachment_text":
            parts.push({
              type: "text",
              text: `${input.manifest}\n${input.text}${input.truncated ? "\n[truncated]" : ""}`,
            });
            break;
          case "attachment_media":
            parts.push({
              type: "text",
              text: `${input.manifest}\n${input.summary}`,
            });
            break;
          default:
            assertNever(input);
        }
      }
    }
  }
  return parts.length === 1 && parts[0]?.type === "text"
    ? parts[0].text
    : parts;
}

function materializeAssistantContent(
  content: readonly HarnessAssistantContent[],
): (TextContent | ThinkingContent | ToolCall)[] | null {
  const result: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const item of content) {
    switch (item.kind) {
      case "text":
        result.push({ type: "text", text: item.text });
        break;
      case "thinking":
        result.push({ type: "thinking", thinking: item.text });
        break;
      case "tool_call": {
        const args = isPiToolArguments(item.arguments) ? item.arguments : null;
        if (args === null) return null;
        result.push({
          type: "toolCall",
          id: item.callId,
          name: item.tool,
          arguments: args,
        });
        break;
      }
      default:
        return assertNever(item, "unexpected history kind");
    }
  }
  return result;
}

function isPiToolArguments(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isPiJsonValue);
}

function isPiJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPiJsonValue);
  return isPiToolArguments(value);
}

function materializeToolOutput(output: HarnessToolOutput): string {
  if (output.kind === "artifact") return output.preview;
  return output.content.map(renderHarnessHistoryContent).join("\n");
}

function normalizeStopReason(value: string): AssistantMessage["stopReason"] {
  switch (value) {
    case "length":
      return "length";
    case "tool_use":
    case "toolUse":
      return "toolUse";
    case "failed":
      return "error";
    case "cancelled":
      return "aborted";
    default:
      return "stop";
  }
}

function materializeUsage(
  input: Variant<HarnessHistoryEntry, "assistant_message">["usage"],
): Usage {
  return {
    input: input.inputTokens,
    output: input.outputTokens,
    cacheRead: input.cachedInputTokens,
    cacheWrite: 0,
    totalTokens: input.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function materializeAssistantHistoryContent(
  content: readonly (TextContent | ThinkingContent | ToolCall)[],
): HarnessAssistantContent[] {
  return content.map(materializeAssistantHistoryBlock);
}

function materializeAssistantHistoryBlock(
  item: TextContent | ThinkingContent | ToolCall,
): HarnessAssistantContent {
  switch (item.type) {
    case "text":
      return {
        kind: "text",
        text: item.text,
        continuation: { kind: "none" },
      };
    case "thinking":
      return {
        kind: "thinking",
        text: item.thinking,
        redacted: item.redacted === true,
        continuation: { kind: "none" },
      };
    case "toolCall":
      return {
        kind: "tool_call",
        callId: item.id,
        tool: item.name,
        arguments: item.arguments,
        continuation: { kind: "none" },
      };
    default:
      return assertNever(item);
  }
}
