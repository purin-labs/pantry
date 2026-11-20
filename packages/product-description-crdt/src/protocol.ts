import {
  COLLABORATION_FRAME_LIMIT,
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  isTextPresenceSelection,
  type CollaborationParticipant,
  type CollaborationPointer,
  type CollaborationPointerPosition,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import {
  productDescriptionDocument,
  type ProductDescriptionUpdate,
  type ProductDescriptionStateVector,
  type ProductDescriptionCrdtError,
  type ProductDescriptionPresenceSelection,
} from "./index.ts";
import { exhaustiveList, isPositiveInteger } from "@purin-labs/std";

export const DESCRIPTION_PROTOCOL = "product_description_sync.v2";
export const FRAME_LIMIT = COLLABORATION_FRAME_LIMIT;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type DraftPointerPosition = CollaborationPointerPosition;
export type DraftPointer = CollaborationPointer;

type RoomCode = "source_unavailable";
type DocumentCode = ProductDescriptionCrdtError["code"] | RoomCode;
export type DraftFailureCode = SyncFailureCode<DocumentCode>;

export type DraftParticipant =
  CollaborationParticipant<ProductDescriptionPresenceSelection>;

export type DraftClientMessage = SyncClientMessage<
  ProductDescriptionPresenceSelection,
  ProductDescriptionStateVector,
  ProductDescriptionUpdate
>;

export type ProductDescriptionRoomMetadata = Readonly<{
  initializedFromProductRevision: number;
  currentProductRevision: number;
}>;

export type DraftServerMessage = SyncServerMessage<
  ProductDescriptionPresenceSelection,
  ProductDescriptionStateVector,
  ProductDescriptionUpdate,
  DocumentCode,
  ProductDescriptionRoomMetadata
>;

const protocol = productDescriptionDocument.syncProtocol<
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  RoomCode
>({
  protocol: DESCRIPTION_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "description",
  isSelection: isTextPresenceSelection,
  roomFailureCodes: exhaustiveList<RoomCode>()(["source_unavailable"]),
  roomMetadata: {
    fields: ["initializedFromProductRevision", "currentProductRevision"],
    isValid: (raw) =>
      isPositiveInteger(raw.initializedFromProductRevision) &&
      isPositiveInteger(raw.currentProductRevision),
  },
});

export const parseDraftClientMessage = protocol.parseClientMessage;
export const parseDraftServerMessage = protocol.parseServerMessage;
export const encodeDraftClientMessage = protocol.encodeClientMessage;
export const encodeDraftServerMessage = protocol.encodeServerMessage;
