import type {
  EvalCriterion,
  EvalCriterionOutcome,
  EvalObservation,
} from "@seams/control-api";
import { assertNever } from "@seams/std";

/**
 * Scores one scenario from what the agent was observed to do. Every
 * criterion is decided from the recorded outcome and reply text alone, so
 * the same observation always scores the same.
 */
export function scoreEvalScenario(
  criteria: readonly EvalCriterion[],
  observation: EvalObservation,
): Readonly<{
  verdict: "passed" | "failed";
  criteria: readonly EvalCriterionOutcome[];
}> {
  const outcomes = criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    met: criterionMet(criterion, observation),
  }));
  return {
    verdict: outcomes.every((outcome) => outcome.met) ? "passed" : "failed",
    criteria: outcomes,
  };
}

function criterionMet(
  criterion: EvalCriterion,
  observation: EvalObservation,
): boolean {
  switch (criterion.kind) {
    case "outcome":
      return observation.outcome === criterion.expected;
    case "reply_includes":
      return replyHolds(observation, criterion.text);
    case "reply_excludes":
      // With no reply there is no text to hold what must be absent.
      return !replyHolds(observation, criterion.text);
    default:
      return assertNever(criterion);
  }
}

function replyHolds(observation: EvalObservation, text: string): boolean {
  return (
    observation.reply !== null &&
    observation.reply.toLowerCase().includes(text.toLowerCase())
  );
}
