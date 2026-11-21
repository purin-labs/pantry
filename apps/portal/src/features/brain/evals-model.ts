import {
  evalConfigurationVerdict,
  type EvalConfiguration,
  type EvalCriterion,
  type EvalReplyOutcome,
  type EvalRevisionView,
  type EvalRoute,
  type EvalRunProgress,
  type EvalRunResult,
  type EvalRunView,
  type EvalScenario,
  type EvalTaskResult,
  type EvalUnavailableReason,
  type EvalView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { StatusChipStatus } from "../../status-chip";

/** The revision runs try, when a person accepted one that still stands. */
export function acceptedEval(view: EvalView): EvalRevisionView | null {
  return (
    view.revisions.find((revision) => revision.kind === "accepted") ?? null
  );
}

/** The candidate waiting for a decision, when the newest revision is one. */
export function openEvalCandidate(view: EvalView): EvalRevisionView | null {
  const head = view.revisions.at(-1);
  return head?.kind === "candidate" ? head : null;
}

/** The revision a reader should see first: what is in use, else the newest. */
export function leadEval(view: EvalView): EvalRevisionView | null {
  return acceptedEval(view) ?? view.revisions.at(-1) ?? null;
}

export function evalStatuses(view: EvalView): readonly StatusChipStatus[] {
  const accepted = acceptedEval(view);
  const candidate = openEvalCandidate(view);
  if (accepted !== null)
    return candidate === null
      ? [{ kind: "success", label: "Reviewed" }]
      : [
          { kind: "success", label: "Reviewed" },
          { kind: "warning", label: "Change to review" },
        ];
  if (candidate !== null) return [{ kind: "warning", label: "Needs review" }];
  const head = view.revisions.at(-1);
  return [
    {
      kind: "neutral",
      label:
        head?.kind === "revoked"
          ? "Revoked"
          : head?.kind === "rejected"
            ? "Declined"
            : "Not in use",
    },
  ];
}

export function outcomeLabel(outcome: EvalReplyOutcome): string {
  switch (outcome) {
    case "reply_now":
      return "Replies at once";
    case "approval_required":
      return "Asks a person to approve the reply";
    case "no_reply":
      return "Sends no reply";
    default:
      return assertNever(outcome, "Unexpected value");
  }
}

/** One criterion in words a reviewer can check. */
export function criterionLabel(criterion: EvalCriterion): string {
  switch (criterion.kind) {
    case "outcome":
      return outcomeLabel(criterion.expected);
    case "reply_includes":
      return `The reply includes “${criterion.text}”`;
    case "reply_excludes":
      return `The reply does not include “${criterion.text}”`;
    default:
      return assertNever(criterion, "Unexpected value");
  }
}

/** When the scenario's message arrives, in the scenario's own time zone. */
export function arrivalLabel(message: EvalScenario["message"]): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: message.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(message.receivedAt));
  return `${local}, ${message.timezone} time`;
}

export const EVAL_ROUTES: readonly EvalRoute[] = [
  "satyr_platform",
  "claude_oauth",
  "codex_subscription",
  "organisation_openai_api_key",
  "organisation_anthropic_api_key",
];

export function routeLabel(route: EvalRoute): string {
  switch (route) {
    case "satyr_platform":
      return "Seams AI";
    case "claude_oauth":
      return "Claude OAuth";
    case "codex_subscription":
      return "Your ChatGPT subscription";
    case "organisation_openai_api_key":
      return "Your OpenAI key";
    case "organisation_anthropic_api_key":
      return "Your Anthropic key";
    case "organisation_google_api_key":
      return "Your Gemini key";
    default:
      return assertNever(route, "Unexpected value");
  }
}

export function configurationLabel(kind: EvalConfiguration["kind"]): string {
  return kind === "current" ? "Memory in use" : "Proposed memory";
}

function unavailableLabel(reason: EvalUnavailableReason): string {
  switch (reason) {
    case "authority_unavailable":
      return "This model is not set up or has no allowance";
    case "budget_exhausted":
      return "The token budget ran out";
    case "agent_unavailable":
      return "The mailbox agent is not active";
    case "fixture_unavailable":
      return "The sender of this scenario is no longer verified";
    case "memory_unavailable":
      return "The memory could not be read";
    default:
      return assertNever(reason, "Unexpected value");
  }
}

/** How one task ended, as a chip. Only an assessed task passes or fails. */
export function taskStatus(task: EvalTaskResult | null): StatusChipStatus {
  if (task === null) return { kind: "neutral", label: "Not run" };
  const { outcome } = task;
  switch (outcome.kind) {
    case "assessed":
      return outcome.verdict === "passed"
        ? { kind: "success", label: "Passed" }
        : { kind: "danger", label: "Failed" };
    case "unavailable":
      return { kind: "neutral", label: "Could not run" };
    case "failed":
      return { kind: "warning", label: "Stopped with an error" };
    case "indeterminate":
      return { kind: "warning", label: "Result unknown" };
    case "cancelled":
      return { kind: "neutral", label: "Cancelled" };
    default:
      return assertNever(outcome, "Unexpected value");
  }
}

/** Why a task has no verdict, or null when it has one. */
export function taskNote(task: EvalTaskResult | null): string | null {
  if (task === null) return null;
  const { outcome } = task;
  switch (outcome.kind) {
    case "assessed":
      return null;
    case "unavailable":
      return `${unavailableLabel(outcome.reason)}. This is not a pass or a fail.`;
    case "failed":
      return "The turn stopped with an error before it gave a result. This is not a fail.";
    case "indeterminate":
      return "The turn was interrupted and its result is not known. Seams Pantry does not run it again in the same run.";
    case "cancelled":
      return "The run was cancelled before this scenario started.";
    default:
      return assertNever(outcome, "Unexpected value");
  }
}

export function isRunInProgress(run: EvalRunView): run is EvalRunProgress {
  return run.state === "pending" || run.state === "running";
}

export function runStatus(run: EvalRunView): StatusChipStatus {
  switch (run.state) {
    case "pending":
      return { kind: "info", label: "Waiting to start" };
    case "running":
      return { kind: "info", label: "Running" };
    case "completed":
      return { kind: "success", label: "Finished" };
    case "failed":
      return { kind: "warning", label: "Finished with an error" };
    case "indeterminate":
      return { kind: "warning", label: "Finished with an unknown result" };
    case "cancelled":
      return { kind: "neutral", label: "Cancelled" };
    default:
      return assertNever(run, "Unexpected value");
  }
}

export function progressLabel(run: EvalRunProgress): string {
  const done = run.tasks.filter((task) => task.state === "settled").length;
  return `${done} of ${run.tasks.length} scenarios done`;
}

/** One sentence on how a configuration did on one route. */
export function verdictSentence(
  run: EvalRunResult,
  configuration: EvalConfiguration["kind"],
  route: EvalRoute,
): string {
  const tasks = run.tasks.filter(
    (task) => task.configuration === configuration && task.route === route,
  );
  const name = configurationLabel(configuration);
  const verdict = evalConfigurationVerdict(run, configuration, route);
  switch (verdict) {
    case "passed":
      return `${name}: passed all ${tasks.length} scenarios.`;
    case "failed": {
      const failed = tasks.filter(
        (task) =>
          task.outcome.kind === "assessed" && task.outcome.verdict === "failed",
      ).length;
      return `${name}: failed ${failed} of ${tasks.length} scenarios.`;
    }
    case "incomplete":
      return `${name}: no complete answer. At least one scenario has no result.`;
    default:
      return assertNever(verdict, "Unexpected value");
  }
}
