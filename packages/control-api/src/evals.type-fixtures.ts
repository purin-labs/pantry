import type {
  EvalAuthor,
  EvalCommand,
  EvalCriterion,
  EvalRunCommand,
  EvalRunResult,
  EvalTaskOutcome,
} from "./evals.ts";

// @ts-expect-error An outcome criterion names an outcome, not reply text.
export const outcomeWithText: EvalCriterion = {
  criterionId: "criterion_a",
  kind: "outcome",
  text: "cutoff",
};

const mixed = {
  criterionId: "criterion_a",
  kind: "reply_includes",
  text: "cutoff",
  expected: "approval_required",
} as const;
// @ts-expect-error A text criterion cannot also expect an outcome.
export const textWithOutcome: EvalCriterion = mixed;

// @ts-expect-error A decision names an exact revision and carries no content.
export const undirectedDecision: EvalCommand = {
  commandId: "command_accept",
  evalId: "eval_a",
  expectedRevision: 1,
  kind: "accept",
};

// @ts-expect-error A revision carries its content and decides nothing.
export const emptyRevision: EvalCommand = {
  commandId: "command_revise",
  evalId: "eval_a",
  expectedRevision: 1,
  kind: "revise",
  revision: 1,
};

const agentWithPerson = {
  kind: "agent",
  caseId: "case_a",
  assignmentId: "assignment_a",
  sessionId: "session_a",
  personId: "person_a",
} as const;
// @ts-expect-error An agent author is never also a person.
export const agentPerson: EvalAuthor = agentWithPerson;

const unavailableWithVerdict = {
  kind: "unavailable",
  reason: "authority_unavailable",
  verdict: "failed",
} as const;
// @ts-expect-error A task that could not run carries no verdict.
export const unavailableVerdict: EvalTaskOutcome = unavailableWithVerdict;

// @ts-expect-error An assessed task states its verdict, criteria and observation.
export const bareAssessment: EvalTaskOutcome = { kind: "assessed" };

const unknownEnd = { kind: "indeterminate", code: "eval_turn_interrupted" };
const withVerdict = { ...unknownEnd, verdict: "failed" } as const;
// @ts-expect-error Spreading a verdict onto an unknown result cannot fail it.
export const failedUnknown: EvalTaskOutcome = withVerdict;

declare const settled: EvalRunResult;
// @ts-expect-error A settled result is never a run in progress.
export const runningResult: EvalRunResult = { ...settled, state: "running" };

// @ts-expect-error Cancelling names the Eval the run belongs to.
export const unplacedCancel: EvalRunCommand = {
  commandId: "command_cancel",
  kind: "cancel",
  runId: "evalrun_a",
};
