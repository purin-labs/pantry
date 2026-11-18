import type { BudgetRevision } from "./BudgetRevision";
import type { RunBudgetReservationId } from "./RunBudgetReservationId";
import type { RunId } from "./RunId";
import type { RuntimeGeneration } from "./RuntimeGeneration";
import type { SessionBudgetAllowance } from "./SessionBudgetAllowance";
import type { Timestamp } from "./Timestamp";
import type { TurnId } from "./TurnId";
import type { TurnLeaseGeneration } from "./TurnLeaseGeneration";

export type RunBudgetReservation = {
  reservationId: RunBudgetReservationId;
  runId: RunId;
  turnId: TurnId;
  runtimeGeneration: RuntimeGeneration;
  turnLeaseGeneration: TurnLeaseGeneration;
  budgetRevision: BudgetRevision;
  allowance: SessionBudgetAllowance;
  acceptedAt: Timestamp;
  deadlineAt: Timestamp;
};
