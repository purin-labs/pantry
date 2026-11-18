export type SupplierPayoutStateKind =
  | "approval_pending"
  | "approved"
  | "submitting"
  | "provider_action_required"
  | "provider_pending"
  | "settled"
  | "return_pending"
  | "returned"
  | "reversal_pending"
  | "reversed"
  | "failed"
  | "indeterminate"
  | "cancelled";
