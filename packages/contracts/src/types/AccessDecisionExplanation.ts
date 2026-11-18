import type { AccessDecisionStage } from "./AccessDecisionStage";
import type { CapabilityMode } from "./CapabilityMode";
import type { EffectiveGrantRef } from "./EffectiveGrantRef";

export type AccessDecisionExplanation =
  | {
      kind: "allowed";
      effectiveGrants: Array<EffectiveGrantRef>;
      policyMode: CapabilityMode;
      flowReaders: Array<string>;
    }
  | {
      kind: "approval_required";
      effectiveGrants: Array<EffectiveGrantRef>;
      policyMode: CapabilityMode;
      reason: string;
    }
  | {
      kind: "denied";
      stage: AccessDecisionStage;
      reason: string;
      remediation: string;
    }
  | {
      kind: "unavailable";
      stage: AccessDecisionStage;
      reason: string;
      remediation: string;
    };
