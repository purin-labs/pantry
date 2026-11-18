
export type OnboardingReadinessBlocker =
  | { code: "readiness_not_evaluated" }
  | { code: "owner_missing" }
  | { code: "placement_missing" }
  | { code: "communication_connection_missing" }
  | { code: "communication_destination_missing" }
  | { code: "commerce_system_missing" }
  | { code: "credential_unresolved"; integration_account_id: string }
  | { code: "webhook_unhealthy"; integration_account_id: string }
  | { code: "policy_snapshot_missing" }
  | { code: "cue_snapshot_missing" }
  | { code: "environment_conflict" }
  | { code: "runtime_admission_unavailable" };
