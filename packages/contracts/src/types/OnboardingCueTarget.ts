
export type OnboardingCueTarget =
  | { kind: "none" }
  | { kind: "slack"; workspace_id: string; channel_id: string };
