import type {
  TypeSafeEvaluationReceipt,
  TypeSafeSettlement,
  TypeSafeUsageAuthority,
  TypeSafeUsageMeasurement,
} from "@purin-labs/agent/typesafe/evaluation-ledger";

// @ts-expect-error A cost estimate alone cannot stand in for measured token usage.
export const incompleteMeasurement: TypeSafeUsageMeasurement = {
  estimatedCostMicrousd: 0,
};

export const inactiveConnection: TypeSafeUsageAuthority = {
  kind: "inactive",
  revision: 1,
  // @ts-expect-error Inactive authority cannot carry a usable connection.
  funding: { kind: "pantry_platform" },
};

// @ts-expect-error Active authority requires pinned connection and limits.
export const incompleteAuthority: TypeSafeUsageAuthority = {
  kind: "active",
  revision: 1,
};

// @ts-expect-error Failed receipts require a provider failure code.
export const incompleteFailure: TypeSafeEvaluationReceipt = {
  kind: "failed",
  evaluationId: "test",
  policyRevision: 1,
};

const evaluated: TypeSafeEvaluationReceipt = {
  kind: "evaluated",
  evaluationId: "test",
  policyRevision: 1,
};

// @ts-expect-error A replay carries no new budget outcome, even through a spread.
export const rebilledReplay: TypeSafeSettlement = {
  ...{ kind: "replayed" as const, receipt: evaluated },
  budget: "exceeded",
};
