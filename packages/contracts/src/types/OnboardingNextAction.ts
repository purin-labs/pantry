import type { OnboardingActionCode } from "./OnboardingActionCode";
import type { OnboardingPresentation } from "./OnboardingPresentation";
import type { OnboardingRetrySafety } from "./OnboardingRetrySafety";

export type OnboardingNextAction =
  | {
      kind: "perform";
      action_code: OnboardingActionCode;
      label: string;
      route: string;
      presentation: OnboardingPresentation;
      retry_safety: OnboardingRetrySafety;
    }
  | {
      kind: "repair";
      action_code: OnboardingActionCode;
      label: string;
      route: string;
      presentation: OnboardingPresentation;
      retry_safety: OnboardingRetrySafety;
      reason_code: string;
    }
  | {
      kind: "wait";
      action_code: OnboardingActionCode;
      label: string;
      retry_after_ms: number;
    }
  | { kind: "done"; action_code: OnboardingActionCode; label: string };
