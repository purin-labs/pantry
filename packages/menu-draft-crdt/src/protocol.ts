import {
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  createSyncProtocol,
  everyCode,
  isShortProtocolText,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import {
  MENU_STATE_VECTOR_LIMIT,
  MENU_UPDATE_LIMIT,
  parseMenuDraftStateVector,
  parseMenuDraftUpdate,
  type MenuDraftCrdtError,
  type MenuDraftStateVector,
  type MenuDraftUpdate,
  type MenuPresenceSelection,
} from "./index.ts";
import { isRecord } from "@purin-labs/std";

export const MENU_DRAFT_PROTOCOL = "menu_draft_sync.v3";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT = 4 * (Math.ceil(MENU_UPDATE_LIMIT / 3) + Math.ceil(MENU_STATE_VECTOR_LIMIT / 3)) + 1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type MenuDraftFailureCode = SyncFailureCode<MenuDraftCrdtError["code"]>;
export type MenuDraftParticipant = CollaborationParticipant<MenuPresenceSelection>;
export type MenuDraftClientMessage = SyncClientMessage<MenuPresenceSelection, MenuDraftStateVector, MenuDraftUpdate>;
export type MenuRoomMetadata = Readonly<{ documentRevision: number }>;
export type MenuDraftServerMessage = SyncServerMessage<
  MenuPresenceSelection,
  MenuDraftStateVector,
  MenuDraftUpdate,
  MenuDraftCrdtError["code"]
>;

const protocol = createSyncProtocol<
  MenuPresenceSelection,
  MenuDraftStateVector,
  MenuDraftUpdate,
  MenuDraftCrdtError["code"]
>({
  protocol: MENU_DRAFT_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "menu draft",
  isSelection: isMenuSelection,
  parseStateVector: parseMenuDraftStateVector,
  parseUpdate: parseMenuDraftUpdate,
  documentFailureCodes: everyCode<MenuDraftCrdtError["code"]>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_document_shape",
    "collection_limit",
    "text_too_long",
    "record_conflict",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
  ]),
});

export const parseMenuDraftClientMessage = protocol.parseClientMessage;
export const parseMenuDraftServerMessage = protocol.parseServerMessage;
export const encodeMenuDraftClientMessage = protocol.encodeClientMessage;
export const encodeMenuDraftServerMessage = protocol.encodeServerMessage;

function isMenuSelection(value: unknown): value is MenuPresenceSelection | null {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  return value.kind === "section" && isShortProtocolText(value.sectionId) ||
    value.kind === "item" && isShortProtocolText(value.itemId);
}
