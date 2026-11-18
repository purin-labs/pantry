import type { AccessApprovalState } from "./AccessApprovalState";
import type { AccessSubjectRef } from "./AccessSubjectRef";
import type { AccessTargetRef } from "./AccessTargetRef";
import type { CapabilityRef } from "./CapabilityRef";
import type { CaseRef } from "./CaseRef";
import type { FlowDestinationRef } from "./FlowDestinationRef";
import type { InformationSourceRef } from "./InformationSourceRef";

export type AccessDecisionQuestion =
  | {
      kind: "capability";
      authoritySubjectRef: AccessSubjectRef;
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
    }
  | {
      kind: "context_read";
      authoritySubjectRef: AccessSubjectRef;
      caseRef: CaseRef;
      sourceRef: InformationSourceRef;
    }
  | {
      kind: "conversation_delivery";
      authoritySubjectRef: AccessSubjectRef;
      sourceRefs: Array<InformationSourceRef>;
      destination: FlowDestinationRef;
    }
  | {
      kind: "tool_effect";
      authoritySubjectRef: AccessSubjectRef;
      sourceRefs: Array<InformationSourceRef>;
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
      approvalState: AccessApprovalState;
    };
