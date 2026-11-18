import type { CaseContent } from "./CaseContent";
import type { CaseId } from "./CaseId";
import type { CaseTriggerId } from "./CaseTriggerId";
import type { CaseTriggerSource } from "./CaseTriggerSource";
import type { RequestAuthority } from "./RequestAuthority";
import type { Timestamp } from "./Timestamp";

export type CaseTrigger = {
  triggerId: CaseTriggerId;
  caseId: CaseId;
  source: CaseTriggerSource;
  requestAuthority: RequestAuthority;
  content: CaseContent;
  acceptedAt: Timestamp;
};
