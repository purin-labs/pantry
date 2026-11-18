import type { ActionClass } from "./ActionClass";
import type { ApprovalAuthenticationBranch } from "./ApprovalAuthenticationBranch";
import type { ApprovalAuthenticationUnreadyReason } from "./ApprovalAuthenticationUnreadyReason";

/**
 * Readiness of one policy-selected approval-authentication branch for an
 * action class. Reported only when an organisation policy selects a non-default
 * branch; it never blocks ordinary organisation readiness.
 */
export type ApprovalAuthenticationReadiness = {
  action_class: ActionClass;
  branch: ApprovalAuthenticationBranch;
  ready: boolean;
  reason: ApprovalAuthenticationUnreadyReason | null;
};
