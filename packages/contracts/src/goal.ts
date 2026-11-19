import { hasExactKeys, isRecord } from "@purin-labs/std";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import type { CaseGoalValue as Goal } from "./record-schemas.ts";
import type { CaseGoalStateValue as State } from "./record-schemas.ts";
import type { CaseGoalSnapshotValue as Snapshot } from "./record-schemas.ts";
import type { CaseGoalCommandValue as Command } from "./record-schemas.ts";
import type { CaseGoalOperationOutcomeValue as Outcome } from "./record-schemas.ts";

export type CaseGoalState = StrictUnion<State>;
export type CaseGoal = Omit<Goal, "state"> & { readonly state: CaseGoalState };
export type CaseGoalSnapshot = StrictUnion<
  | Variant<Snapshot, "none">
  | {
      readonly kind: "present";
      readonly revision: number;
      readonly goal: CaseGoal;
    }
>;
export type CaseGoalCommand = StrictUnion<Command>;
export type CaseGoalOperationOutcome = StrictUnion<Outcome>;

function parseState(value: unknown): CaseGoalState | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "active":
    case "paused":
    case "budget_limited":
    case "cleared":
      return hasExactKeys(value, ["kind"]) ? { kind: value.kind } : null;
    case "completed":
      return hasExactKeys(value, ["kind", "evidence"]) && text(value.evidence)
        ? { kind: "completed", evidence: value.evidence }
        : null;
    default:
      return null;
  }
}
export function parseCaseGoal(value: unknown): CaseGoal | null {
  if (
    !isRecord(value) ||
    !identifier(value.goalId) ||
    !identifier(value.organisationId) ||
    !identifier(value.caseId) ||
    !text(value.objective) ||
    !counter(value.tokenBudget) ||
    value.tokenBudget === 0 ||
    !counter(value.tokensUsed) ||
    !counter(value.activeTimeMs) ||
    !counter(value.unknownOperations)
  )
    return null;
  const state = parseState(value.state);
  if (
    state === null ||
    (state.kind === "active" && value.tokensUsed >= value.tokenBudget)
  )
    return null;
  return {
    goalId: value.goalId,
    organisationId: value.organisationId,
    caseId: value.caseId,
    objective: value.objective,
    tokenBudget: value.tokenBudget,
    tokensUsed: value.tokensUsed,
    activeTimeMs: value.activeTimeMs,
    unknownOperations: value.unknownOperations,
    state,
  };
}
export function parseCaseGoalSnapshot(value: unknown): CaseGoalSnapshot | null {
  if (!isRecord(value) || !counter(value.revision)) return null;
  if (value.kind === "none") return { kind: "none", revision: value.revision };
  if (value.kind !== "present") return null;
  const goal = parseCaseGoal(value.goal);
  return goal === null
    ? null
    : { kind: "present", revision: value.revision, goal };
}

function counter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 4000
  );
}
