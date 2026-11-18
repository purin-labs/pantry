
export type OnboardingIntegrationAccountLifecycle =
  | { kind: "connecting" }
  | { kind: "pending_activation" }
  | { kind: "active" }
  | { kind: "degraded"; reason_code: string }
  | { kind: "reauth_required"; reason_code: string }
  | { kind: "disabled"; disabled_by_user_id: string; disabled_at: number }
  | { kind: "revoked"; revoked_at: number };
