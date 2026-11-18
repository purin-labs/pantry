
export type AccessApprovalState =
  | { kind: "not_required" }
  | { kind: "pending"; approvalRequestId: string }
  | { kind: "approved"; approvalReceiptId: string };
