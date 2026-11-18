
export type OnboardingAudiencePolicy =
  { kind: "operator" } | { kind: "customer"; consent_required: boolean };
