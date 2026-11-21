import type { CommandId } from "./CommandId";
import type { SessionBudgetDimension } from "./SessionBudgetDimension";
import type { SessionBudgetExhaustionId } from "./SessionBudgetExhaustionId";
import type { SessionProposalId } from "./SessionProposalId";
import type { Timestamp } from "./Timestamp";

export type CaseAssignmentTerminalDisposition =
  | { kind: "completed"; proposalId: SessionProposalId; settledAt: Timestamp }
  | { kind: "cancelled"; commandId: CommandId; settledAt: Timestamp }
  | { kind: "failed"; code: string; settledAt: Timestamp }
  | {
      kind: "budget_exhausted";
      exhaustionId: SessionBudgetExhaustionId;
      dimension: SessionBudgetDimension;
      settledAt: Timestamp;
    }
  | {
      kind: "abandoned";
      reason: CaseAssignmentAbandonReason;
      settledAt: Timestamp;
    };

/**
 * Why an assignment that nothing will finish was ended (Refactor 15,
 * refactor 9). `never_started`: no turn began under it. `session_quiescent`:
 * its Session runs no turn, and the turn under it cannot finish.
 */
type CaseAssignmentAbandonReason = "never_started" | "session_quiescent";
