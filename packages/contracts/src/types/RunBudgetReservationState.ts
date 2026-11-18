import type { RunBudgetIndeterminateReason } from "./RunBudgetIndeterminateReason";
import type { RunBudgetReservation } from "./RunBudgetReservation";
import type { SessionBudgetUsage } from "./SessionBudgetUsage";

export type RunBudgetReservationState =
  | { kind: "none" }
  | {
      kind: "active";
      reservation: RunBudgetReservation;
      acceptedUsage: SessionBudgetUsage;
    }
  | {
      kind: "indeterminate";
      reservation: RunBudgetReservation;
      acceptedUsage: SessionBudgetUsage;
      reason: RunBudgetIndeterminateReason;
    };
