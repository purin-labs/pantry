import type { EffectReceiptId } from "./EffectReceiptId";
import type { TurnIdentity } from "./TurnIdentity";
import type { WorkspaceRevisionReceipt } from "./WorkspaceRevisionReceipt";

export type ReducingResultTurn = {
  identity: TurnIdentity;
  receiptId: EffectReceiptId;
  workspaceRevisionReceipt: WorkspaceRevisionReceipt;
};
