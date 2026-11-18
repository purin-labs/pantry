import type { ModelRequestId } from "./ModelRequestId";
import type { Timestamp } from "./Timestamp";
import type { TurnIdentity } from "./TurnIdentity";

export type ReasoningTurn = {
  identity: TurnIdentity;
  modelRequestId: ModelRequestId;
  startedAt: Timestamp;
};
