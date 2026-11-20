// The errors of the activation of an Organisation.
export type OnboardingActivationError =
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "activation_readiness_stale"; readonly detail: string }
  | { readonly code: "activation_state_invalid" }
  | { readonly code: "activation_attempt_corrupt" }
  | { readonly code: "activation_attempt_in_progress" }
  | ActivationExecutionFailure;

export type ActivationExecutionFailure = {
  readonly code:
    | "activation_interrupted"
    | "activation_policy_failed"
    | "activation_cues_failed"
    | "activation_publish_failed";
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly supportReference: string;
};
