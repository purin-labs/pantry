import {
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  createSyncProtocol,
  everyCode,
  type CollaborationAgentActivity,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncMessageFields,
  type SyncServerMessage,
} from "@seams/collaboration";
import { isRecord } from "@seams/std";
import {
  CANVAS_ENCODING_LIMITS,
  CanvasEncoding,
  type CanvasFailureCode,
} from "./index";

type CanvasUpdate = CanvasEncoding<"update">;
type CanvasStateVector = CanvasEncoding<"state_vector">;
export type CanvasSelection = Readonly<{ objectId: string }>;

export const CANVAS_PROTOCOL = "workflow_canvas_sync.v2";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT =
  4 *
    (Math.ceil(CANVAS_ENCODING_LIMITS.state / 3) +
      Math.ceil(CANVAS_ENCODING_LIMITS.stateVector / 3)) +
  1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type CanvasProtocolFailureCode = SyncFailureCode<CanvasFailureCode>;
export type CanvasParticipant = CollaborationParticipant<CanvasSelection>;
export type CanvasClientMessage = SyncClientMessage<
  CanvasSelection,
  CanvasStateVector,
  CanvasUpdate
>;
export type CanvasRoomMetadata = Readonly<{ documentRevision: number }>;
export type CanvasLastChange = "initial" | "human" | "agent";

type LastChange = Readonly<{ lastChange: CanvasLastChange }>;
type CanvasExtension = {
  syncResponse: LastChange;
  updateAccepted: LastChange;
  updateBroadcast: LastChange;
  presence: Readonly<{ agents: readonly CollaborationAgentActivity[] }>;
  // The canvas's chat changed. The frame carries no content: the page reads
  // the chat through its checked route.
  signal: "chat_changed";
};

export type CanvasServerMessage = SyncServerMessage<
  CanvasSelection,
  CanvasStateVector,
  CanvasUpdate,
  CanvasFailureCode,
  CanvasRoomMetadata,
  CanvasExtension
>;

const LAST_CHANGE: SyncMessageFields = {
  fields: ["lastChange"],
  isValid: (raw) => isCanvasLastChange(raw.lastChange),
};

const protocol = createSyncProtocol<
  CanvasSelection,
  CanvasStateVector,
  CanvasUpdate,
  CanvasFailureCode,
  CanvasRoomMetadata,
  CanvasExtension
>({
  protocol: CANVAS_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "workflow canvas",
  isSelection: isCanvasSelection,
  parseStateVector: (bytes) => CanvasEncoding.parse("state_vector", bytes),
  parseUpdate: (bytes) => CanvasEncoding.parse("update", bytes),
  documentFailureCodes: everyCode<CanvasFailureCode>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_layout",
    "object_conflict",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
  ]),
  syncResponseFields: LAST_CHANGE,
  updateAcceptedFields: LAST_CHANGE,
  updateBroadcastFields: LAST_CHANGE,
  signals: ["chat_changed"],
});

export const parseCanvasClientMessage = protocol.parseClientMessage;
export const parseCanvasServerMessage = protocol.parseServerMessage;
export const encodeCanvasClientMessage = protocol.encodeClientMessage;
export const encodeCanvasServerMessage = protocol.encodeServerMessage;

export function isCanvasLastChange(value: unknown): value is CanvasLastChange {
  return value === "initial" || value === "human" || value === "agent";
}

function isCanvasSelection(value: unknown): value is CanvasSelection | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.objectId === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value.objectId)
  );
}
