import type { BudgetRevision } from "./BudgetRevision";

export type SessionBudget = {
  budgetRevision: BudgetRevision;
  maxTokens: number;
  maxWallMs: number;
  maxToolCalls: number;
};
