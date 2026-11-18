
export type ActionState =
  | "proposed"
  | "approval_requested"
  | "signed"
  | "executing"
  | "confirmed"
  | "failed"
  | "rejected"
  | "indeterminate"
  | "expired";
