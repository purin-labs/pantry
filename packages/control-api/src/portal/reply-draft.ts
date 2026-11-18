import type {
  MailReplyPresenceSelection,
  MailReplyStateVector,
  MailReplyUpdate,
} from "@seams/mail-reply-crdt";
import {
  parseDraftServerMessage,
  type DraftFailureCode,
  type DraftServerMessage,
  type MailReplyRoomMetadata,
} from "@seams/mail-reply-crdt/protocol";
import { assertNever } from "@seams/std";
import type { TextCollaborationServerMessage } from "./text-collaboration.ts";

export function parseReplyServerMessage(frame: unknown) {
  const parsed = parseDraftServerMessage(frame);
  if (!parsed.ok) return parsed;
  return {
    ok: true as const,
    value: normalizeReplyServerMessage(parsed.value),
  };
}

function normalizeReplyServerMessage(
  message: DraftServerMessage,
): TextCollaborationServerMessage<
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  DraftFailureCode
> {
  switch (message.kind) {
    case "sync_response":
      return {
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        metadata: {
          savedVersion: message.savedVersion,
          unsaved: message.unsaved,
        },
        access: message.access,
        sessionId: message.sessionId,
      };
    case "update_accepted":
    case "update_broadcast":
    case "presence_changed":
    case "failure":
      return message;
    default:
      return assertNever(message, "Unexpected reply draft branch");
  }
}
