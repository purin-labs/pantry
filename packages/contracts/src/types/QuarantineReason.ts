
export type QuarantineReason =
  | "activation_failure"
  | "integrity_failure"
  | "replay_failure"
  | "effect_indeterminate"
  | "journal_budget_exceeded"
  | "migration_blocked";
