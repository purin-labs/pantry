import type { ApprovalRequestId } from "./ApprovalRequestId";
import type { EffectId } from "./EffectId";
import type { TurnIdentity } from "./TurnIdentity";

export type AwaitingApprovalTurn = {
  identity: TurnIdentity;
  approvalRequestId: ApprovalRequestId;
  effectId: EffectId;
};
