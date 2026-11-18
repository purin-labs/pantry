import type { CaseGoalOperationOutcome } from "@seams/contracts";
import type { StrictUnion } from "@seams/type-utils";
import type { Result } from "../result";
import { assertNever } from "@seams/std";

export type GoalModelCallTicket = {
  readonly operationId: string;
  readonly startedAt: number;
  readonly goalId: string;
  readonly objective: string;
  readonly remainingTokens: number;
};

export type GoalModelCallControl = StrictUnion<
  | { readonly kind: "untracked" }
  | {
      readonly kind: "tracked";
      begin(): Promise<Result<GoalModelCallTicket, GoalModelStop>>;
      settle(
        ticket: GoalModelCallTicket,
        outcome: CaseGoalOperationOutcome,
      ): Promise<void>;
    }
>;

export type GoalModelStop = {
  readonly goalId: string;
  readonly kind:
    "budget_limited" | "paused" | "completed" | "cleared" | "replaced";
};

export function goalStopMessage(stop: GoalModelStop): string {
  switch (stop.kind) {
    case "budget_limited":
      return "The goal token budget has been reached. Work is saved. Increase the budget and explicitly resume the goal to continue.";
    case "paused":
      return "The goal is paused. Work is saved. Explicitly resume the goal to continue.";
    case "completed":
      return "The goal is marked complete. This turn has stopped and its work is saved.";
    case "cleared":
      return "The goal was cleared. This turn has stopped and its work is saved.";
    case "replaced":
      return "The goal was replaced. Work for the previous goal is saved. Start a new turn for the current goal.";
    default:
      return assertNever(stop.kind);
  }
}
