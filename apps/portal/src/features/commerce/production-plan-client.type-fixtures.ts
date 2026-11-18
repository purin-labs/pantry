import type { ProductionPlanView } from "./production-plan-client";

declare const failed: ProductionPlanView & { kind: "failed" };
declare const synced: ProductionPlanView & { kind: "synced" };

// @ts-expect-error A failed view must state whether the connection can retry.
const missingRecovery: ProductionPlanView = {
  ...synced,
  kind: "failed",
  message: "Unavailable",
};

// @ts-expect-error A synced view cannot expose a recovery action.
const mixedState: ProductionPlanView = { ...synced, recovery: "retry" };

// @ts-expect-error A broad spread cannot retain a failure in a synced view.
const failedSpread: ProductionPlanView = { ...failed, kind: "synced" };

// @ts-expect-error A direct cast cannot turn a failed view into a synced view.
const unsafeCast = failed as ProductionPlanView & { kind: "synced" };
