
export type OnboardingWebhookHealth =
  | { kind: "healthy" }
  | { kind: "degraded" }
  | { kind: "missing" }
  | { kind: "disabled" };
