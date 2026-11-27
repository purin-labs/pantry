import {
  COLLABORATION_FRAME_LIMIT,
  isTextPresenceSelection,
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

const DESCRIPTION_PROTOCOL = "product_description_sync.v2";
export const FRAME_LIMIT = COLLABORATION_FRAME_LIMIT;

type RoomCode = "source_unavailable";
type DocumentCode = ProductDescriptionCrdtError["code"] | RoomCode;
export type DraftFailureCode = SyncFailureCode<DocumentCode>;

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
