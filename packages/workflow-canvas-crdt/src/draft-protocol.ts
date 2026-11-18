import {
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  createSyncProtocol,
  everyCode,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@seams/collaboration";
import { isRecord } from "@seams/std";
import {
  DRAFT_ENCODING_LIMITS,
  DraftEncoding,
  type DraftFailureCode,
} from "./draft";

type DraftUpdate = DraftEncoding<"update">;
type DraftStateVector = DraftEncoding<"state_vector">;
export type DraftSelection = Readonly<{ objectId: string }>;

export const DRAFT_PROTOCOL = "workflow_draft_sync.v1";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT =
  4 *
    (Math.ceil(DRAFT_ENCODING_LIMITS.state / 3) +
      Math.ceil(DRAFT_ENCODING_LIMITS.stateVector / 3)) +
  1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type DraftProtocolFailureCode = SyncFailureCode<DraftFailureCode>;
export type DraftParticipant = CollaborationParticipant<DraftSelection>;
export type DraftClientMessage = SyncClientMessage<
  DraftSelection,
  DraftStateVector,
  DraftUpdate
>;
export type DraftRoomMetadata = Readonly<{ documentRevision: number }>;

type DraftExtension = {
  syncResponse: unknown;
  updateAccepted: unknown;
  updateBroadcast: unknown;
  // The presence frame of a draft carries no agents.
  presence: unknown;
  // A person applied a revision. The page reads it through its checked route.
  signal: "revision_changed";
};

export type DraftServerMessage = SyncServerMessage<
  DraftSelection,
  DraftStateVector,
  DraftUpdate,
  DraftFailureCode,
  DraftRoomMetadata,
  DraftExtension
>;

const protocol = createSyncProtocol<
  DraftSelection,
  DraftStateVector,
  DraftUpdate,
  DraftFailureCode,
  DraftRoomMetadata,
  DraftExtension
>({
  protocol: DRAFT_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "workflow draft",
  isSelection: isDraftSelection,
  parseStateVector: (bytes) => DraftEncoding.parse("state_vector", bytes),
  parseUpdate: (bytes) => DraftEncoding.parse("update", bytes),
  documentFailureCodes: everyCode<DraftFailureCode>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_draft",
    "object_limit",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
  ]),
  presenceFields: { fields: [], isValid: () => true },
  signals: ["revision_changed"],
});

export const parseDraftClientMessage = protocol.parseClientMessage;
export const parseDraftServerMessage = protocol.parseServerMessage;
export const encodeDraftClientMessage = protocol.encodeClientMessage;
export const encodeDraftServerMessage = protocol.encodeServerMessage;

function isDraftSelection(value: unknown): value is DraftSelection | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.objectId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/.test(value.objectId)
  );
}
