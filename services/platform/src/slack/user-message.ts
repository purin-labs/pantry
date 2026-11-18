import type {
  UserMessage,
  UserMessagePart,
  StoredMessageAttachment,
} from "@seams/contracts";

import {
  deriveUserMessageViews,
  type DerivedUserMessage,
  type MessageContractRejection,
} from "../messages/message-wasm";
import type { Result } from "../result";
import type {
  SlackAuthoredPart,
  SlackFileCandidate,
  SlackMessageEvent,
} from "./events";
import { assertNever } from "@seams/std";

/**
 * Assembles the canonical message for one Slack delivery.
 *
 * The order is Pantry's, not Slack's: Slack exposes authored content and files
 * through separate fields and defines no interleaving. Authored parts come
 * first in the order of the selected representation, then remote-file links,
 * then committed files in `files[]` order.
 */
export function buildSlackUserMessage(
  event: SlackMessageEvent,
  attachments: readonly StoredMessageAttachment[],
): Result<
  DerivedUserMessage,
  MessageContractRejection | { readonly code: "empty_message" }
> {
  const parts: UserMessagePart[] = [];

  for (const authored of event.authored) {
    parts.push(authoredPart(authored));
  }

  for (const candidate of event.files) {
    // A file Slack does not host is a link, never admitted bytes.
    if (candidate.kind === "remote_link") {
      parts.push({
        kind: "link",
        link: {
          url: candidate.url as UserMessagePart extends { link: infer L }
            ? L extends { url: infer U }
              ? U
              : never
            : never,
          presentation: { kind: "label", label: candidate.label as never },
        },
      });
    }
  }

  for (const attachment of attachments) {
    parts.push({ kind: "attachment", attachment });
  }

  const first = parts[0];

  if (first === undefined) {
    return { ok: false, error: { code: "empty_message" } };
  }

  const message: UserMessage = {
    firstPart: first,
    remainingParts: parts.slice(1),
  };

  // Round-trips through Lexicon so every branded value is minted by the
  // contract's own constructors rather than asserted here.
  return deriveUserMessageViews(message);
}

function authoredPart(authored: SlackAuthoredPart): UserMessagePart {
  switch (authored.kind) {
    case "text":
      return { kind: "text", text: authored.text as never };
    case "link":
      return {
        kind: "link",
        link: {
          url: authored.url as never,
          presentation:
            authored.label === null
              ? { kind: "url" }
              : { kind: "label", label: authored.label as never },
        },
      };
    default:
      return assertNever(authored, "Unhandled Slack authored part");
  }
}

export type { SlackFileCandidate };
