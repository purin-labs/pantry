import type {
  EvalRunView,
  EvalView,
  MemoryEvidence,
  MemoryRevisionState,
  MemoryView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import { evalConfigurationVerdict } from "@purin-labs/control-api";

import { acceptedEval, isRunInProgress } from "./evals-model";
import { acceptedRevision, evidenceLabel } from "./model";

/**
 * The learning loop as the records show it: what the agents learned from,
 * what was proposed, what was tried, what a person decided and what is in
 * use. Each number counts records that this person may read. Nothing here
 * reads a connected system.
 */
export type LearningFlow = Readonly<{
  /** The records that a Memory or an Eval cites, by their kind. */
  sources: readonly Readonly<{
    kind: MemoryEvidence["kind"];
    label: string;
    count: number;
  }>[];
  /** Versions of a Memory that the agent or a person proposed. */
  proposed: number;
  /** Runs of an Eval, in progress or settled. */
  runs: number;
  /** Decisions of a person: accepted, declined or revoked. */
  decisions: number;
  memoriesInUse: number;
  evalsInUse: number;
}>;

export type LearningEventKind =
  "memory_proposed" | "eval_proposed" | "decision" | "eval_run";

/** One line of the learning log. */
export type LearningEvent = Readonly<{
  key: string;
  at: number;
  kind: LearningEventKind;
  /** Where the event came from, in words. */
  source: string;
  sentence: string;
  /** The record that the line is about. */
  target: Readonly<
    { kind: "memory"; memoryId: string } | { kind: "eval"; evalId: string }
  >;
}>;

export function learningEventLabel(kind: LearningEventKind): string {
  switch (kind) {
    case "memory_proposed":
      return "Memory proposed";
    case "eval_proposed":
      return "Eval proposed";
    case "decision":
      return "Decision";
    case "eval_run":
      return "Eval run";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

const SOURCE_KINDS: readonly MemoryEvidence["kind"][] = [
  "proposal_correction",
  "operator_instruction",
  "case_observation",
  "case_context_collection",
];

function sourceLabel(kind: MemoryEvidence["kind"]): string {
  switch (kind) {
    case "proposal_correction":
      return "Corrections of email replies";
    case "operator_instruction":
      return "Instructions of a person";
    case "case_observation":
      return "Observations in a Case";
    case "case_context_collection":
      return "Collected Case context";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

function countDecisions(revisions: readonly MemoryRevisionState[]): number {
  let decisions = 0;
  for (const revision of revisions)
    switch (revision.kind) {
      case "candidate":
        break;
      case "accepted":
      case "superseded":
        decisions += 1;
        break;
      case "rejected":
        // A reviewer's edit replaces a candidate. It decides nothing.
        if (revision.rejection.reason === "declined") decisions += 1;
        break;
      case "revoked":
        decisions += 2;
        break;
      default:
        assertNever(revision, "Unexpected value");
    }
  return decisions;
}

export function learningFlow(
  memories: readonly MemoryView[],
  evals: readonly EvalView[],
  runs: Readonly<Record<string, readonly EvalRunView[]>>,
): LearningFlow {
  const cited = new Map<MemoryEvidence["kind"], Set<string>>();
  const cite = (evidence: readonly MemoryEvidence[]): void => {
    for (const record of evidence) {
      const records = cited.get(record.kind) ?? new Set<string>();
      records.add(JSON.stringify(record));
      cited.set(record.kind, records);
    }
  };
  let proposed = 0;
  let decisions = 0;
  for (const memory of memories) {
    proposed += memory.revisions.length;
    decisions += countDecisions(memory.revisions);
    for (const revision of memory.revisions) cite(revision.evidence);
  }
  for (const entry of evals) {
    decisions += countDecisions(entry.revisions);
    for (const revision of entry.revisions) cite(revision.evidence);
  }
  return {
    sources: SOURCE_KINDS.flatMap((kind) => {
      const count = cited.get(kind)?.size ?? 0;
      return count === 0 ? [] : [{ kind, label: sourceLabel(kind), count }];
    }),
    proposed,
    runs: Object.values(runs).reduce((sum, list) => sum + list.length, 0),
    decisions,
    memoriesInUse: memories.filter(
      (memory) => acceptedRevision(memory) !== null,
    ).length,
    evalsInUse: evals.filter((entry) => acceptedEval(entry) !== null).length,
  };
}

function shorten(text: string): string {
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function authorWords(
  by: Readonly<{ kind: "agent" | "operator" | "pantry" }>,
): string {
  return by.kind === "operator" ? "A person" : "The agent";
}

/** The decisions that the states of one version record, each with its time. */
function decisionEvents(
  revision: MemoryRevisionState & Readonly<{ revision: number }>,
  subject: string,
): readonly Readonly<{ at: number; sentence: string; step: string }>[] {
  switch (revision.kind) {
    case "candidate":
      return [];
    case "accepted":
      return [
        {
          at: revision.acceptance.decidedAt,
          sentence: `A person accepted ${subject}.`,
          step: "accepted",
        },
      ];
    case "superseded":
      return [
        {
          at: revision.acceptance.decidedAt,
          sentence: `A person accepted ${subject}.`,
          step: "accepted",
        },
      ];
    case "rejected":
      return revision.rejection.reason === "declined"
        ? [
            {
              at: revision.rejection.decidedAt,
              sentence: `A person declined ${subject}.`,
              step: "declined",
            },
          ]
        : [];
    case "revoked":
      return [
        {
          at: revision.acceptance.decidedAt,
          sentence: `A person accepted ${subject}.`,
          step: "accepted",
        },
        {
          at: revision.revocation.decidedAt,
          sentence: `A person revoked ${subject}.`,
          step: "revoked",
        },
      ];
    default:
      return assertNever(revision, "Unexpected value");
  }
}

function runSentence(run: EvalRunView, title: string): string {
  if (isRunInProgress(run)) return `A run of "${title}" is in progress.`;
  if (run.state === "cancelled") return `A run of "${title}" was cancelled.`;
  if (run.state !== "completed")
    return `A run of "${title}" ended with no complete result.`;
  const parts = run.configurations.map((configuration) => {
    const verdicts = run.routes.map((route) =>
      evalConfigurationVerdict(run, configuration.kind, route),
    );
    const name =
      configuration.kind === "candidate"
        ? "the proposed memory"
        : "the memory in use";
    if (verdicts.every((verdict) => verdict === "passed"))
      return `${name} passed`;
    if (verdicts.some((verdict) => verdict === "failed"))
      return `${name} failed`;
    return `${name} has no complete answer`;
  });
  return `A run of "${title}" finished: ${parts.join(", ")}.`;
}

/** The learning log, the newest event first. */
export function learningLog(
  memories: readonly MemoryView[],
  evals: readonly EvalView[],
  runs: Readonly<Record<string, readonly EvalRunView[]>>,
): readonly LearningEvent[] {
  const events: LearningEvent[] = [];
  for (const memory of memories) {
    const target = { kind: "memory", memoryId: memory.memoryId } as const;
    for (const revision of memory.revisions) {
      const subject = `the memory "${shorten(revision.statement)}"`;
      const source = revision.evidence.map(evidenceLabel).join(". ");
      events.push({
        key: `memory:${memory.memoryId}:${String(revision.revision)}:proposed`,
        at: revision.proposedAt,
        kind: "memory_proposed",
        source,
        sentence: `${authorWords(revision.proposedBy)} proposed ${subject}.`,
        target,
      });
      for (const decision of decisionEvents(revision, subject))
        events.push({
          key: `memory:${memory.memoryId}:${String(revision.revision)}:${decision.step}`,
          at: decision.at,
          kind: "decision",
          source: "The Brain page",
          sentence: decision.sentence,
          target,
        });
    }
  }
  for (const entry of evals) {
    const target = { kind: "eval", evalId: entry.evalId } as const;
    for (const revision of entry.revisions) {
      const subject = `the eval "${shorten(revision.title)}"`;
      events.push({
        key: `eval:${entry.evalId}:${String(revision.revision)}:proposed`,
        at: revision.proposedAt,
        kind: "eval_proposed",
        source: revision.evidence.map(evidenceLabel).join(". "),
        sentence: `${authorWords(revision.proposedBy)} proposed ${subject}.`,
        target,
      });
      for (const decision of decisionEvents(revision, subject))
        events.push({
          key: `eval:${entry.evalId}:${String(revision.revision)}:${decision.step}`,
          at: decision.at,
          kind: "decision",
          source: "The Brain page",
          sentence: decision.sentence,
          target,
        });
    }
    const title = shorten(
      (acceptedEval(entry) ?? entry.revisions.at(-1))?.title ?? "an eval",
    );
    for (const run of runs[entry.evalId] ?? [])
      events.push({
        key: `run:${run.runId}`,
        at: isRunInProgress(run) ? run.startedAt : run.settledAt,
        kind: "eval_run",
        source: "An eval run",
        sentence: runSentence(run, title),
        target,
      });
  }
  return events.sort((left, right) => right.at - left.at);
}
