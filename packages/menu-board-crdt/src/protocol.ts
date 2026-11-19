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
  MENU_BOARD_MAX_COORDINATE,
  MENU_BOARD_MOVING_LIMIT,
  MENU_BOARD_STATE_VECTOR_LIMIT,
  isMenuBoardId,
  isMenuBoardRect,
  MENU_BOARD_UPDATE_LIMIT,
  parseMenuBoardStateVector,
  parseMenuBoardUpdate,
  type MenuBoardCrdtError,
  type MenuBoardStateVector,
  type MenuBoardUpdate,
  type MenuBoardPresenceSelection,
} from "./index.ts";
import { isRecord } from "@purin-labs/std";

export const MENU_BOARD_PROTOCOL = "menu_board_sync.v1";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT = 4 * (Math.ceil(MENU_BOARD_UPDATE_LIMIT / 3) + Math.ceil(MENU_BOARD_STATE_VECTOR_LIMIT / 3)) + 1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type MenuBoardFailureCode = SyncFailureCode<MenuBoardCrdtError["code"]>;
export type MenuBoardParticipant = CollaborationParticipant<MenuBoardPresenceSelection>;
export type MenuBoardClientMessage = SyncClientMessage<MenuBoardPresenceSelection, MenuBoardStateVector, MenuBoardUpdate>;
export type MenuBoardRoomMetadata = Readonly<{ documentRevision: number }>;
export type MenuBoardServerMessage = SyncServerMessage<
  MenuBoardPresenceSelection,
  MenuBoardStateVector,
  MenuBoardUpdate,
  MenuBoardCrdtError["code"]
>;

const protocol = createSyncProtocol<
  MenuBoardPresenceSelection,
  MenuBoardStateVector,
  MenuBoardUpdate,
  MenuBoardCrdtError["code"]
>({
  protocol: MENU_BOARD_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "menu board",
  isSelection: isBoardSelection,
  parseStateVector: parseMenuBoardStateVector,
  parseUpdate: parseMenuBoardUpdate,
  documentFailureCodes: everyCode<MenuBoardCrdtError["code"]>()([
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

export const parseMenuBoardClientMessage = protocol.parseClientMessage;
export const parseMenuBoardServerMessage = protocol.parseServerMessage;
export const encodeMenuBoardClientMessage = protocol.encodeClientMessage;
export const encodeMenuBoardServerMessage = protocol.encodeServerMessage;

/** A drag's presence stays small: a socket's presence lives in its 2 KiB attachment. */
const MOVING_SELECTION_BYTES = 900;

function isBoardSelection(value: unknown): value is MenuBoardPresenceSelection | null {
  if (value === null) return true;
  if (isRecord(value) && value.kind === "moving") return isMovingSelection(value);
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  return value.kind === "element" && isShortProtocolText(value.elementId) ||
    value.kind === "frame" && isShortProtocolText(value.frameId);
}

function isMovingSelection(value: Readonly<Record<string, unknown>>): boolean {
  const ids = value.elementIds;
  if (
    Object.keys(value).length !== 5 ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MENU_BOARD_MOVING_LIMIT ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => isMenuBoardId(id) && isShortProtocolText(id))
  )
    return false;
  const offset = value.offset;
  const moved =
    offset !== null &&
    isRecord(offset) &&
    Object.keys(offset).length === 2 &&
    isOffset(offset.x) &&
    isOffset(offset.y) &&
    isRecord(value.from) &&
    Object.keys(value.from).length === 2 &&
    isOffset(value.from.x) &&
    isOffset(value.from.y) &&
    value.rect === null;
  // A resize moves one element to a new rect.
  const resized =
    offset === null && value.from === null && ids.length === 1 && isMenuBoardRect(value.rect);
  return (moved || resized) && JSON.stringify(value).length <= MOVING_SELECTION_BYTES;
}

function isOffset(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 2 * MENU_BOARD_MAX_COORDINATE
  );
}
