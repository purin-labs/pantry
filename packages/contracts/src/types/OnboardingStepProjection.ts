import type { OnboardingActionCode } from "./OnboardingActionCode";
import type { OnboardingStepName } from "./OnboardingStepName";

export type OnboardingStepProjection =
  | { kind: "unavailable"; step: OnboardingStepName; reason_code: string }
  | {
      kind: "available";
      step: OnboardingStepName;
      action: OnboardingActionCode;
    }
  | {
      kind: "in_progress";
      step: OnboardingStepName;
      attempt_id: string;
      started_at: number;
    }
  | {
      kind: "action_required";
      step: OnboardingStepName;
      reason_code: string;
      action: OnboardingActionCode;
    }
  | {
      kind: "complete";
      step: OnboardingStepName;
      completed_at: number;
      receipt_id: string;
    };
