import type { Budget } from "./Budget";

export type AuthzRules = {
  allowedTools: Array<string>;
  deniedTools: Array<string>;
  approvalRequired: Array<string>;
  maxBudget: Budget | null;
};
