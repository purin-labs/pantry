import {
  COLLABORATION_FRAME_LIMIT,
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  isTextPresenceSelection,
  type CollaborationParticipant,
  type CollaborationPointerPosition,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import {
  emailDraftDocument,
  isEmailDraftField,
  type EmailDraftCrdtError,
  type EmailDraftSelection,
  type EmailDraftStateVector,
  type EmailDraftUpdate,
} from "./index.ts";
import { isRecord } from "@purin-labs/std";

export const EMAIL_DRAFT_PROTOCOL = "email_draft_sync.v2";
export const FRAME_LIMIT = COLLABORATION_FRAME_LIMIT;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type EmailDraftPointerPosition = CollaborationPointerPosition;
export type EmailDraftParticipant =
  CollaborationParticipant<EmailDraftSelection>;
export type EmailDraftFailureCode = SyncFailureCode<EmailDraftCrdtError["code"]>;

export type EmailDraftClientMessage = SyncClientMessage<EmailDraftSelection, EmailDraftStateVector, EmailDraftUpdate>;
export type EmailDraftRoomMetadata = Readonly<{ documentRevision: number }>;
export type EmailDraftServerMessage = SyncServerMessage<
  EmailDraftSelection,
  EmailDraftStateVector,
  EmailDraftUpdate,
  EmailDraftCrdtError["code"]
>;

const protocol = emailDraftDocument.syncProtocol({
  protocol: EMAIL_DRAFT_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "email draft",
  isSelection: isEmailDraftSelection,
});

export const parseEmailDraftClientMessage = protocol.parseClientMessage;
export const parseEmailDraftServerMessage = protocol.parseServerMessage;
export const encodeEmailDraftClientMessage = protocol.encodeClientMessage;
export const encodeEmailDraftServerMessage = protocol.encodeServerMessage;

function isEmailDraftSelection(value: unknown): value is EmailDraftSelection | null {
  return value === null || isRecord(value) && Object.keys(value).length === 2 &&
    isEmailDraftField(value.field) && isTextPresenceSelection(value.anchor) && value.anchor !== null;
}
