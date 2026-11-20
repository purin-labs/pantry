import type {
  ProductDescriptionPresenceSelection,
  ProductDescriptionStateVector,
  ProductDescriptionUpdate,
} from "@purin-labs/product-description-crdt";
import {
  parseDraftServerMessage,
  type DraftFailureCode,
  type DraftServerMessage,
  type ProductDescriptionRoomMetadata,
} from "@purin-labs/product-description-crdt/protocol";
import type { TextCollaborationServerMessage } from "@purin-labs/collaboration";
import { assertNever } from "@purin-labs/std";

export function parseDescriptionServerMessage(frame: unknown) {
  const parsed = parseDraftServerMessage(frame);
  if (!parsed.ok) return parsed;
  return {
    ok: true as const,
    value: normalizeDescriptionServerMessage(parsed.value),
  };
}

function normalizeDescriptionServerMessage(
  message: DraftServerMessage,
): TextCollaborationServerMessage<
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  DraftFailureCode
> {
  switch (message.kind) {
    case "sync_response":
      return {
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        metadata: {
          initializedFromProductRevision:
            message.initializedFromProductRevision,
          currentProductRevision: message.currentProductRevision,
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
      return assertNever(
        message,
        "Unexpected description collaboration branch",
      );
  }
}
