import {
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  snapshotFrameLimit,
  type CollaborationAgentActivity,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncMessageFields,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import { isRecord } from "@purin-labs/std";
import {
  CANVAS_ENCODING_LIMITS,
  workflowCanvasEncoding,
  type CanvasEncoding,
  type CanvasFailureCode,
} from "./index.ts";

type CanvasUpdate = CanvasEncoding<"update">;
type CanvasStateVector = CanvasEncoding<"state_vector">;
export type CanvasSelection = Readonly<{ objectId: string }>;

export const CANVAS_PROTOCOL = "workflow_canvas_sync.v2";
export const FRAME_LIMIT = snapshotFrameLimit(
  CANVAS_ENCODING_LIMITS.state,
  CANVAS_ENCODING_LIMITS.stateVector,
);
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

const protocol = workflowCanvasEncoding.syncProtocol<
  CanvasSelection,
  CanvasRoomMetadata,
  never,
  CanvasExtension
>({
  protocol: CANVAS_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "workflow canvas",
  isSelection: isCanvasSelection,
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
