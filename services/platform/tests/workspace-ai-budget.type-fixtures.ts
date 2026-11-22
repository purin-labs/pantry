import type { DirectCaseCommandError } from "@purin-labs/conversation/actors/case-direct-processing";

// @ts-expect-error Exhaustion requires the pinned budget and measured usage.
const missingBudget: DirectCaseCommandError = { kind: "budget_exhausted", code: "session_turn:budget_exhausted" };
const failed: DirectCaseCommandError = { kind: "operational", code: "failed" };
// @ts-expect-error A broad spread cannot turn an operational failure into exhaustion.
const invalidSpread: DirectCaseCommandError = { ...failed, kind: "budget_exhausted", code: "session_turn:budget_exhausted" };
void missingBudget;
void invalidSpread;
