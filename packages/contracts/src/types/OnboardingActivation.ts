import type { OnboardingActivationPhase } from "./OnboardingActivationPhase";

export type OnboardingActivation =
  | { kind: "idle"; organisation_id: string }
  | {
      kind: "running";
      activation_attempt_id: string;
      phase: OnboardingActivationPhase;
      started_at: number;
    }
  | {
      kind: "succeeded";
      activation_attempt_id: string;
      activation_receipt_id: string;
      activated_at: number;
    }
  | {
      kind: "failed_retryable";
      activation_attempt_id: string;
      phase: OnboardingActivationPhase;
      reason_code: string;
      retry_after_ms: number;
    }
  | {
      kind: "failed_terminal";
      activation_attempt_id: string;
      phase: OnboardingActivationPhase;
      reason_code: string;
    };
