import {
  isTextPresenceSelection,
  snapshotFrameLimit,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import { STATE_VECTOR_LIMIT, UPDATE_LIMIT } from "./limits.ts";
import {
  mailReplyDocument,
  type MailReplyUpdate,
  type MailReplyStateVector,
  type MailReplyCrdtError,
  type MailReplyPresenceSelection,
} from "./index.ts";
import { exhaustiveList, isPositiveInteger } from "@purin-labs/std";

const MAIL_REPLY_PROTOCOL = "mail_reply_sync.v1";
/** A sync response carries the whole state and a state vector in base64. */
export const FRAME_LIMIT = snapshotFrameLimit(UPDATE_LIMIT, STATE_VECTOR_LIMIT);

type RoomCode = "source_unavailable" | "draft_closed";
type DocumentCode = MailReplyCrdtError["code"] | RoomCode;
export type DraftFailureCode = SyncFailureCode<DocumentCode>;

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

const protocol = mailReplyDocument.syncProtocol<
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  RoomCode
>({
  protocol: MAIL_REPLY_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "mail reply",
  isSelection: isTextPresenceSelection,
  roomFailureCodes: exhaustiveList<RoomCode>()([
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
