import type { ActorRefV1 } from "./ActorRefV1";
import type { ApprovalReceiptId } from "./ApprovalReceiptId";
import type { CommerceTimestamp } from "@seams/commerce-contracts";
import type { PolicyVersion } from "./PolicyVersion";

export type ApprovalV1 = {
  receiptId: ApprovalReceiptId;
  policyVersion: PolicyVersion;
  approvedBy: ActorRefV1;
  approvedAt: CommerceTimestamp;
};
