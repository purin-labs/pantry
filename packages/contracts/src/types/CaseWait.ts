import type { ApprovalRequestId } from "./ApprovalRequestId";
import type { CaseTriggerId } from "./CaseTriggerId";
import type { ScheduleId } from "./ScheduleId";

export type CaseWait =
  | { kind: "input"; triggerId: CaseTriggerId }
  | { kind: "approval"; approvalRequestId: ApprovalRequestId }
  | { kind: "schedule"; scheduleId: ScheduleId };
