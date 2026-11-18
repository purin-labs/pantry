import type { ExhaustedRunBudgetReservation } from "./ExhaustedRunBudgetReservation";
import type { RunBudgetReservationState } from "./RunBudgetReservationState";
import type { SessionBudget } from "./SessionBudget";
import type { SessionBudgetEventSequence } from "./SessionBudgetEventSequence";
import type { SessionBudgetExhaustion } from "./SessionBudgetExhaustion";
import type { SessionBudgetUsage } from "./SessionBudgetUsage";

export type SessionBudgetAccount =
  | {
      kind: "open";
      budget: SessionBudget;
      usage: SessionBudgetUsage;
      usageCursor: SessionBudgetEventSequence;
      reservation: RunBudgetReservationState;
    }
  | {
      kind: "exhausted";
      budget: SessionBudget;
      usage: SessionBudgetUsage;
      usageCursor: SessionBudgetEventSequence;
      exhaustion: SessionBudgetExhaustion;
      reservation: ExhaustedRunBudgetReservation;
    };
