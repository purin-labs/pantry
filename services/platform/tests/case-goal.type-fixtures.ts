import type { TransientModelTurnError } from "@purin-labs/agent/actors/session/types";
import type { GoalUsageAuthority } from "@purin-labs/agent/actors/session-goal-usage";
import type { GoalExecutionRequest } from "@purin-labs/agent/actors/case-goals";
import type {
  GoalModelCallControl,
  GoalModelStop,
} from "@purin-labs/agent/actors/goal-model-calls";
import type {
  HarnessTurnLease,
  CaseGoalCommand,
  CaseGoalOperationOutcome,
  CaseGoalSnapshot,
  CaseGoalState,
} from "@purin-labs/contracts";

// @ts-expect-error A pause command cannot also change its budget.
const mixedCommand: CaseGoalCommand = { kind: "pause", tokenBudget: 100 };
const budgetFields = { tokenBudget: 100 };
// @ts-expect-error Broad spreads cannot add a budget to a pause command.
const spreadCommand: CaseGoalCommand = { kind: "pause", ...budgetFields };
// @ts-expect-error Completion requires evidence.
const incompleteState: CaseGoalState = { kind: "completed" };
// @ts-expect-error An active state cannot carry completion evidence.
const mixedState: CaseGoalState = { kind: "active", evidence: "receipt" };
// @ts-expect-error Unknown usage cannot contain measured tokens.
const mixedUsage: CaseGoalOperationOutcome = { kind: "unknown", tokens: 0 };
// @ts-expect-error A missing goal cannot carry a goal payload.
const missingGoal: CaseGoalSnapshot = { kind: "none", revision: 0, goal: {} };
void [
  mixedCommand,
  spreadCommand,
  incompleteState,
  mixedState,
  mixedUsage,
  missingGoal,
];

const trackedFields = {
  begin: async function begin(): ReturnType<
    Extract<GoalModelCallControl, { kind: "tracked" }>["begin"]
  > {
    return {
      ok: true,
      value: {
        operationId: "op",
        startedAt: 1,
        goalId: "goal",
        objective: "Review stock",
        remainingTokens: 100,
      },
    };
  },
};
// @ts-expect-error A tracked dispatch control requires durable settlement.
const unsettledControl: GoalModelCallControl = {
  kind: "tracked",
  ...trackedFields,
};
// @ts-expect-error Broad spreads cannot attach tracked admission to an untracked control.
const mixedControl: GoalModelCallControl = {
  kind: "untracked",
  ...trackedFields,
};
void [unsettledControl, mixedControl];

// @ts-expect-error A goal stop must identify the bound goal.
const anonymousStop: GoalModelStop = { kind: "paused" };
// @ts-expect-error Unknown usage cannot be converted into a resumable goal stop.
const unknownStop: GoalModelStop = { goalId: "goal", kind: "unknown" };
void [anonymousStop, unknownStop];

declare const transientLease: HarnessTurnLease;
// @ts-expect-error Canonical ownership cannot include transient run state.
const mixedGoalAuthority: GoalUsageAuthority = {
  kind: "canonical",
  lease: transientLease,
  runId: "run",
  tokenAllowance: 100,
};
const transientFields = { runId: "run", tokenAllowance: 100 };
// @ts-expect-error Spreading transient fields cannot create canonical ownership.
const spreadGoalAuthority: GoalUsageAuthority = {
  kind: "canonical",
  lease: transientLease,
  ...transientFields,
};
// @ts-expect-error Transient ownership requires its allowance.
const incompleteGoalAuthority: GoalUsageAuthority = {
  kind: "transient",
  lease: transientLease,
  runId: "run",
};
void mixedGoalAuthority;
void spreadGoalAuthority;
void incompleteGoalAuthority;

// @ts-expect-error A failed transient attempt must state whether usage is known.
const missingTransientUsage: TransientModelTurnError = {
  code: "provider_failed",
};
void missingTransientUsage;

const attemptIdentity = {
  organisationId: "organisation",
  caseId: "case",
  executionId: "attempt",
};
// @ts-expect-error An attempt must identify its durable logical request.
const missingGoalRequest: GoalExecutionRequest = { ...attemptIdentity };
void missingGoalRequest;
