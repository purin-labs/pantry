import {
  snapshotFrameLimit,
  type CollaborationParticipant,
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncServerMessage,
} from "@purin-labs/collaboration";
import { isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  isPlanRequestId,
  PLAN_STATE_VECTOR_LIMIT,
  PLAN_UPDATE_LIMIT,
  productionPlanDocument,
  type ProductionPlanCrdtError,
  type ProductionPlanSelection,
  type ProductionPlanStateVector,
  type ProductionPlanUpdate,
} from "./index.ts";

export const PRODUCTION_PLAN_PROTOCOL = "production_plan_sync.v1";
export const FRAME_LIMIT = snapshotFrameLimit(
  PLAN_UPDATE_LIMIT,
  PLAN_STATE_VECTOR_LIMIT,
);

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

const protocol = productionPlanDocument.syncProtocol<
  ProductionPlanSelection,
  PlanRoomMetadata
>({
  protocol: PRODUCTION_PLAN_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  label: "production plan",
  isSelection: isPlanSelection,
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
