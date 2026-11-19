import {
  COLLABORATION_FRAME_LIMIT,
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  createSyncProtocol,
  everyCode,
  isTextPresenceSelection,
  type CollaborationParticipant,
  type CollaborationPointer,
  type CollaborationPointerPosition,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import {
  parseMailReplyUpdate,
  parseMailReplyStateVector,
  type MailReplyUpdate,
  type MailReplyStateVector,
  type MailReplyCrdtError,
  type MailReplyPresenceSelection,
} from "./index.ts";
import { isPositiveInteger } from "@purin-labs/std";

export const MAIL_REPLY_PROTOCOL = "mail_reply_sync.v1";
export const FRAME_LIMIT = COLLABORATION_FRAME_LIMIT;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type DraftPointerPosition = CollaborationPointerPosition;
export type DraftPointer = CollaborationPointer;

type DocumentCode = MailReplyCrdtError["code"] | "source_unavailable" | "draft_closed";
export type DraftFailureCode = SyncFailureCode<DocumentCode>;

export type DraftParticipant =
  CollaborationParticipant<MailReplyPresenceSelection>;

export type DraftClientMessage = SyncClientMessage<
  MailReplyPresenceSelection,
  MailReplyStateVector,
  MailReplyUpdate
>;

/**
 * `savedVersion` is the Gmail reply version that the room's text started
 * from or last saved. `unsaved` is true when the text differs from it.
 */
export type MailReplyRoomMetadata = Readonly<{
  savedVersion: number;
  unsaved: boolean;
}>;

export type DraftServerMessage = SyncServerMessage<
  MailReplyPresenceSelection,
  MailReplyStateVector,
  MailReplyUpdate,
  DocumentCode,
  MailReplyRoomMetadata
>;

const protocol = createSyncProtocol<
  MailReplyPresenceSelection,
  MailReplyStateVector,
  MailReplyUpdate,
  DocumentCode,
  MailReplyRoomMetadata
>({
  protocol: MAIL_REPLY_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "mail reply",
  isSelection: isTextPresenceSelection,
  parseStateVector: parseMailReplyStateVector,
  parseUpdate: parseMailReplyUpdate,
  documentFailureCodes: everyCode<DocumentCode>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_document_shape",
    "body_too_long",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
    "source_unavailable",
    "draft_closed",
  ]),
  roomMetadata: {
    fields: ["savedVersion", "unsaved"],
    isValid: (raw) =>
      isPositiveInteger(raw.savedVersion) && typeof raw.unsaved === "boolean",
  },
});

export const parseDraftClientMessage = protocol.parseClientMessage;
export const parseDraftServerMessage = protocol.parseServerMessage;
export const encodeDraftClientMessage = protocol.encodeClientMessage;
export const encodeDraftServerMessage = protocol.encodeServerMessage;
