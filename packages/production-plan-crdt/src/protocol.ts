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
  isPlanRequestId,
  parseProductionPlanStateVector,
  parseProductionPlanUpdate,
  PLAN_STATE_VECTOR_LIMIT,
  PLAN_UPDATE_LIMIT,
  type ProductionPlanCrdtError,
  type ProductionPlanSelection,
  type ProductionPlanStateVector,
  type ProductionPlanUpdate,
} from "./index.ts";

export const PRODUCTION_PLAN_PROTOCOL = "production_plan_sync.v1";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT =
  4 *
    (Math.ceil(PLAN_UPDATE_LIMIT / 3) +
      Math.ceil(PLAN_STATE_VECTOR_LIMIT / 3)) +
  1024;

export type PlanFailureCode = SyncFailureCode<ProductionPlanCrdtError["code"]>;
export type PlanParticipant = CollaborationParticipant<ProductionPlanSelection>;
export type PlanClientMessage = SyncClientMessage<
  ProductionPlanSelection,
  ProductionPlanStateVector,
  ProductionPlanUpdate
>;
/**
 * `generation` changes when the room replaces a grown document with a compact
 * copy. A client that held the earlier generation discards its copy, because
 * merging old history into the new copy could bring back old quantities.
 */
export type PlanRoomMetadata = Readonly<{
  documentRevision: number;
  generation: number;
}>;
export type PlanServerMessage = SyncServerMessage<
  ProductionPlanSelection,
  ProductionPlanStateVector,
  ProductionPlanUpdate,
  ProductionPlanCrdtError["code"],
  PlanRoomMetadata
>;

const protocol = createSyncProtocol<
  ProductionPlanSelection,
  ProductionPlanStateVector,
  ProductionPlanUpdate,
  ProductionPlanCrdtError["code"],
  PlanRoomMetadata
>({
  protocol: PRODUCTION_PLAN_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "production plan",
  isSelection: isPlanSelection,
  parseStateVector: parseProductionPlanStateVector,
  parseUpdate: parseProductionPlanUpdate,
  documentFailureCodes: everyCode<ProductionPlanCrdtError["code"]>()([
    "invalid_state",
    "invalid_update",
    "invalid_state_vector",
    "invalid_document_shape",
    "collection_limit",
    "quantity_invalid",
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

export const parsePlanClientMessage = protocol.parseClientMessage;
export const parsePlanServerMessage = protocol.parseServerMessage;
export const encodePlanClientMessage = protocol.encodeClientMessage;
export const encodePlanServerMessage = protocol.encodeServerMessage;

function isPlanSelection(
  value: unknown,
): value is ProductionPlanSelection | null {
  return (
    value === null ||
    (isRecord(value) &&
      Object.keys(value).length === 1 &&
      isPlanRequestId(value.requestId))
  );
}
