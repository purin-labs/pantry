import type { RunBudgetReservationState } from "@seams/contracts";

// @ts-expect-error Indeterminate reservations must preserve the reason for uncertainty.
const invalidIndeterminateReservation: RunBudgetReservationState = {
  kind: "indeterminate",
  reservation: {
    reservationId: "reservation_1",
    runId: "run_1",
    turnId: "turn_1",
    runtimeGeneration: 1,
    turnLeaseGeneration: 1,
    budgetRevision: "budget_1",
    allowance: { tokens: 10, activeWallMs: 100, capabilityCalls: 1 },
    acceptedAt: 1,
    deadlineAt: 101,
  },
  acceptedUsage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
};

void invalidIndeterminateReservation;
