import type { ApprovalRequestId } from "./ApprovalRequestId";

export type CaseWait = {
  kind: "approval";
  approvalRequestId: ApprovalRequestId;
};
