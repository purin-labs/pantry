import type { EvalView, MemoryView } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type {
  AgentDefinition,
  Skill,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { StatusChipStatus } from "../../status-chip";
import type { KnowledgeState } from "./address";
import {
  acceptedEval,
  evalStatuses,
  leadEval,
  openEvalCandidate,
} from "./evals-model";
import {
  acceptedRevision,
  applicabilityLabel,
  lastChangedAt,
  leadRevision,
  memoryStatuses,
  openCandidate,
  revisionChangedAt,
} from "./model";

/** The kinds of record that the Knowledge view lists, in the rail's order. */
export type KnowledgeKind = "memory" | "evals" | "playbooks" | "agents";

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
  "memory",
  "evals",
  "playbooks",
  "agents",
];

export function knowledgeKindLabel(kind: KnowledgeKind): string {
  switch (kind) {
    case "memory":
      return "Memory";
    case "evals":
      return "Evals";
    case "playbooks":
      return "Playbooks";
    case "agents":
      return "Agents";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

/** One record of the Knowledge list, whatever its kind. */
export type KnowledgeRow = Readonly<{
  kind: KnowledgeKind;
  id: string;
  title: string;
  /** Where it applies, in words. */
  scope: string;
  /** The time of its last change, when its record holds one. */
  changedAt: number | null;
  statuses: readonly StatusChipStatus[];
  /** What the record is doing now. One in use can also have a candidate. */
  states: readonly KnowledgeState[];
}>;

function reviewedStates(
  waits: boolean,
  inUse: boolean,
): readonly KnowledgeState[] {
  if (waits && inUse) return ["review", "in_use"];
  if (waits) return ["review"];
  return inUse ? ["in_use"] : ["not_in_use"];
}

export function memoryRow(memory: MemoryView): KnowledgeRow | null {
  const lead = leadRevision(memory);
  if (lead === null) return null;
  return {
    kind: "memory",
    id: memory.memoryId,
    title: lead.statement,
    scope: applicabilityLabel(lead.applicability),
    changedAt: lastChangedAt(memory),
    statuses: memoryStatuses(memory),
    states: reviewedStates(
      openCandidate(memory) !== null,
      acceptedRevision(memory) !== null,
    ),
  };
}

function evalChangedAt(view: EvalView): number {
  let latest = 0;
  for (const revision of view.revisions)
    latest = Math.max(
      latest,
      revision.proposedAt,
      revisionChangedAt(revision) ?? 0,
    );
  return latest;
}

export function evalRow(view: EvalView): KnowledgeRow | null {
  const lead = leadEval(view);
  if (lead === null) return null;
  const scenarios = lead.scenarios.length;
  return {
    kind: "evals",
    id: view.evalId,
    title: lead.title,
    scope: `Replies of one mailbox, ${scenarios === 1 ? "1 scenario" : `${scenarios} scenarios`}`,
    changedAt: evalChangedAt(view),
    statuses: evalStatuses(view),
    states: reviewedStates(
      openEvalCandidate(view) !== null,
      acceptedEval(view) !== null,
    ),
  };
}

export function playbookRow(skill: Skill): KnowledgeRow {
  const published = skill.lifecycle === "published";
  return {
    kind: "playbooks",
    id: skill.skillId,
    title: skill.title,
    scope:
      skill.sensitivity === "sensitive"
        ? "A playbook for sensitive work"
        : "A playbook that agents load",
    changedAt: null,
    statuses: [
      published
        ? { kind: "success", label: "Published" }
        : { kind: "neutral", label: "Archived" },
    ],
    states: [published ? "in_use" : "not_in_use"],
  };
}

export function agentRow(agent: AgentDefinition): KnowledgeRow {
  const active = agent.lifecycle === "active";
  return {
    kind: "agents",
    id: agent.agentDefinitionId,
    title: agent.displayName,
    scope: agent.purpose.length > 0 ? agent.purpose : "An agent",
    changedAt: null,
    statuses: [
      active
        ? { kind: "success", label: "Active" }
        : { kind: "neutral", label: "Archived" },
    ],
    states: [active ? "in_use" : "not_in_use"],
  };
}

/**
 * The order of one kind: what waits for a decision first, then the rest.
 * Each group has its most recent change first. Records with no time keep the
 * order of their read.
 */
export function rowsForReview(
  rows: readonly KnowledgeRow[],
): readonly KnowledgeRow[] {
  return [...rows].sort(
    (left, right) =>
      Number(right.states.includes("review")) -
        Number(left.states.includes("review")) ||
      (right.changedAt ?? 0) - (left.changedAt ?? 0),
  );
}

/** The rows that a state filter and a search leave. */
export function filterRows(
  rows: readonly KnowledgeRow[],
  state: KnowledgeState | null,
  search: string,
): readonly KnowledgeRow[] {
  const words = search
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  return rows.filter((row) => {
    if (state !== null && !row.states.includes(state)) return false;
    const text = `${row.title} ${row.scope}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function stateFilterLabel(state: KnowledgeState | null): string {
  switch (state) {
    case null:
      return "All";
    case "review":
      return "Needs review";
    case "in_use":
      return "In use";
    case "not_in_use":
      return "Not in use";
    default:
      return assertNever(state, "Unexpected value");
  }
}
