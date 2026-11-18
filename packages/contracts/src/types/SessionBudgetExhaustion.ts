import type { RunId } from "./RunId";
import type { SessionBudgetDimension } from "./SessionBudgetDimension";
import type { SessionBudgetExhaustionId } from "./SessionBudgetExhaustionId";
import type { SessionBudgetUsage } from "./SessionBudgetUsage";
import type { Timestamp } from "./Timestamp";

export type SessionBudgetExhaustion = {
  exhaustionId: SessionBudgetExhaustionId;
  dimension: SessionBudgetDimension;
  runId: RunId;
  observedUsage: SessionBudgetUsage;
  exhaustedAt: Timestamp;
};
