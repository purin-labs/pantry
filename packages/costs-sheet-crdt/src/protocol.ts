import {
  snapshotFrameLimit,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import { isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  COSTS_SHEET_STATE_VECTOR_LIMIT,
  COSTS_SHEET_UPDATE_LIMIT,
  costsSheetDocument,
  isCostsSheetSelectionKey,
  isCostsSheetTab,
  type CostsSheetCrdtError,
  type CostsSheetSelection,
  type CostsSheetStateVector,
  type CostsSheetUpdate,
} from "./index.ts";

export const COSTS_SHEET_PROTOCOL = "costs_sheet_sync.v1";

export const FRAME_LIMIT = snapshotFrameLimit(
  COSTS_SHEET_UPDATE_LIMIT,
  COSTS_SHEET_STATE_VECTOR_LIMIT,
);

export type CostsSheetFailureCode = SyncFailureCode<
  CostsSheetCrdtError["code"]
>;
export type CostsSheetParticipant =
  CollaborationParticipant<CostsSheetSelection>;
export type CostsSheetClientMessage = SyncClientMessage<
  CostsSheetSelection,
  CostsSheetStateVector,
  CostsSheetUpdate
>;
export type CostsSheetRoomMetadata = Readonly<{
  documentRevision: number;
  generation: number;
}>;
export type CostsSheetServerMessage = SyncServerMessage<
  CostsSheetSelection,
  CostsSheetStateVector,
  CostsSheetUpdate,
  CostsSheetCrdtError["code"],
  CostsSheetRoomMetadata
>;

const protocol = costsSheetDocument.syncProtocol<
  CostsSheetSelection,
  CostsSheetRoomMetadata
>({
  protocol: COSTS_SHEET_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "costs sheet",
  isSelection: isCostsSheetSelection,
  roomMetadata: {
    fields: ["documentRevision", "generation"],
    isValid: (raw) =>
      isPositiveInteger(raw.documentRevision) &&
      isPositiveInteger(raw.generation),
  },
});

export const parseCostsSheetClientMessage = protocol.parseClientMessage;
export const parseCostsSheetServerMessage = protocol.parseServerMessage;
export const encodeCostsSheetClientMessage = protocol.encodeClientMessage;
export const encodeCostsSheetServerMessage = protocol.encodeServerMessage;

function isCostsSheetSelection(
  value: unknown,
): value is CostsSheetSelection | null {
  return (
    value === null ||
    (isRecord(value) &&
      Object.keys(value).length === 2 &&
      isCostsSheetTab(value.sheet) &&
      (value.cellKey === null || isCostsSheetSelectionKey(value.cellKey)))
  );
}
