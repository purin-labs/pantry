import {
  createSyncProtocol,
  everyCode,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@seams/collaboration";
import { isPositiveInteger, isRecord } from "@seams/std";
import {
  COSTS_SHEET_STATE_VECTOR_LIMIT,
  COSTS_SHEET_UPDATE_LIMIT,
  isCostsSheetSelectionKey,
  isCostsSheetTab,
  parseCostsSheetStateVector,
  parseCostsSheetUpdate,
  type CostsSheetCrdtError,
  type CostsSheetSelection,
  type CostsSheetStateVector,
  type CostsSheetUpdate,
} from "./index";

export const COSTS_SHEET_PROTOCOL = "costs_sheet_sync.v1";

export const FRAME_LIMIT =
  4 *
    (Math.ceil(COSTS_SHEET_UPDATE_LIMIT / 3) +
      Math.ceil(COSTS_SHEET_STATE_VECTOR_LIMIT / 3)) +
  1024;

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

const protocol = createSyncProtocol<
  CostsSheetSelection,
  CostsSheetStateVector,
  CostsSheetUpdate,
  CostsSheetCrdtError["code"],
  CostsSheetRoomMetadata
>({
  protocol: COSTS_SHEET_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "costs sheet",
  isSelection: isCostsSheetSelection,
  parseStateVector: parseCostsSheetStateVector,
  parseUpdate: parseCostsSheetUpdate,
  documentFailureCodes: everyCode<CostsSheetCrdtError["code"]>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_document_shape",
    "collection_limit",
    "cell_invalid",
    "record_conflict",
    "update_too_large",
    "state_too_large",
    "state_vector_too_large",
  ]),
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
