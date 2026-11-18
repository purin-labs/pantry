import type {
  CaseContent,
  StoredMessageAttachment,
  UserMessage,
} from "@seams/contracts";
import { deriveUserMessageViews } from "../messages/message-wasm";
import { parseSourceProvenance } from "../commerce/source-provenance";
import type { Variant } from "@seams/type-utils";

export function parseMessageCaseContent(
  value: unknown,
): Variant<CaseContent, "user_message" | "record_message"> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    !("message" in value)
  )
    return null;
  if (value.kind !== "user_message" && value.kind !== "record_message")
    return null;
  const derived = deriveUserMessageViews(value.message);
  if (!derived.ok) return null;
  if (value.kind === "user_message")
    return { kind: "user_message", message: derived.value.message };
  const provenance =
    "provenance" in value ? parseSourceProvenance(value.provenance) : null;
  return provenance === null
    ? null
    : { kind: "record_message", message: derived.value.message, provenance };
}

/**
 * The attachments a Case entry owns.
 *
 * Attachments live in the message's own ordered parts, so there is one place
 * they can come from. Content that is not an admitted user message — a
 * generated entry, a terminal summary, a commerce reference — owns none.
 */
export function caseContentAttachments(
  content: CaseContent,
): readonly StoredMessageAttachment[] {
  return content.kind === "user_message" || content.kind === "record_message"
    ? userMessageAttachments(content.message)
    : [];
}

export function userMessageAttachments(
  message: UserMessage,
): readonly StoredMessageAttachment[] {
  const attachments: StoredMessageAttachment[] = [];

  for (const part of [message.firstPart, ...message.remainingParts]) {
    if (part.kind === "attachment") {
      attachments.push(part.attachment);
    }
  }

  return attachments;
}

/**
 * The authored instruction for a turn: text and links in canonical order.
 *
 * Attachments are deliberately excluded. They reach the harness as typed input
 * parts — a verified image as native image input, anything else as a manifest —
 * so rendering them here as well would show the agent every file twice.
 */
export function caseContentInstruction(
  content: CaseContent,
  fallback: string,
): string {
  if (content.kind === "text") {
    return content.text;
  }

  if (content.kind !== "user_message" && content.kind !== "record_message") {
    return fallback;
  }

  const rendered: string[] = [];

  for (const part of [
    content.message.firstPart,
    ...content.message.remainingParts,
  ]) {
    if (part.kind === "text") {
      rendered.push(part.text);
      continue;
    }

    if (part.kind === "link") {
      rendered.push(
        part.link.presentation.kind === "label"
          ? `[link] ${part.link.presentation.label} (${part.link.url})`
          : `[link] ${part.link.url}`,
      );
    }
  }

  return rendered.length === 0 ? fallback : rendered.join("\n");
}
