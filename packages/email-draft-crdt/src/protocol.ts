import {
  COLLABORATION_FRAME_LIMIT,
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  createSyncProtocol,
  everyCode,
  isTextPresenceSelection,
  type CollaborationParticipant,
  type CollaborationPointerPosition,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import {
  isEmailDraftField,
  parseEmailDraftStateVector,
  parseEmailDraftUpdate,
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

const protocol = createSyncProtocol<
  EmailDraftSelection,
  EmailDraftStateVector,
  EmailDraftUpdate,
  EmailDraftCrdtError["code"]
>({
  protocol: EMAIL_DRAFT_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "email draft",
  isSelection: isEmailDraftSelection,
  parseStateVector: parseEmailDraftStateVector,
  parseUpdate: parseEmailDraftUpdate,
  documentFailureCodes: everyCode<EmailDraftCrdtError["code"]>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_document_shape",
    "field_too_long",
    "draft_too_long",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
  ]),
});

export const parseEmailDraftClientMessage = protocol.parseClientMessage;
export const parseEmailDraftServerMessage = protocol.parseServerMessage;
export const encodeEmailDraftClientMessage = protocol.encodeClientMessage;
export const encodeEmailDraftServerMessage = protocol.encodeServerMessage;

function isEmailDraftSelection(value: unknown): value is EmailDraftSelection | null {
  return value === null || isRecord(value) && Object.keys(value).length === 2 &&
    isEmailDraftField(value.field) && isTextPresenceSelection(value.anchor) && value.anchor !== null;
}
