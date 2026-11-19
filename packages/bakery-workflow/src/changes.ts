import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  draftNodeId,
  type DraftChangeSet,
  type DraftEdge,
  type DraftNode,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft-shape";
import {
  draftSeed,
  edgeKey,
  newStepNode,
  withStepSeconds,
  withStepWorkers,
  workflowDiff,
  type DraftProblem,
} from "./draft.ts";
import type { BakeryWorkflowDocument } from "./index.ts";

/** The changes that one proposal can make. A larger change is several proposals. */
export const MAX_WORKFLOW_CHANGES = 32;

export type WorkflowChange =
  | Readonly<{
      kind: "add_step";
      workflow: string;
      step: string;
      label: string;
      stepKind: "work" | "wait";
      seconds: number;
    }>
  | Readonly<{
      kind: "add_decision";
      workflow: string;
      step: string;
      label: string;
    }>
  | Readonly<{ kind: "remove_node"; workflow: string; step: string }>
  | Readonly<{
      kind: "connect";
      workflow: string;
      from: string;
      to: string;
      outcome: "accept" | "reject" | null;
    }>
  | Readonly<{ kind: "disconnect"; workflow: string; from: string; to: string }>
  | Readonly<{
      kind: "set_step";
      workflow: string;
      step: string;
      label: string | null;
      seconds: number | null;
      workers: readonly string[] | null;
    }>;

const STEP_KEY = /^[a-z0-9][a-z0-9-]{0,99}$/u;

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function label(value: unknown): value is string {
  return text(value) && value.length <= 200;
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= 86_400;
}

function outcome(value: unknown): value is "accept" | "reject" | null {
  return value === null || value === "accept" || value === "reject";
}

/**
 * Reads the changes that a model sent. A model fills every field of its schema, with
 * null for those that a kind does not use, so this reads the fields of each kind.
 */
export function parseWorkflowChanges(raw: unknown): WorkflowChange[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_WORKFLOW_CHANGES
  )
    return null;
  const changes: WorkflowChange[] = [];
  for (const item of raw) {
    const change = parseChange(item);
    if (change === null) return null;
    changes.push(change);
  }
  return changes;
}

function parseChange(raw: unknown): WorkflowChange | null {
  if (!isRecord(raw) || !text(raw.workflow)) return null;
  const { kind, workflow, step, from, to } = raw;
  switch (kind) {
    case "add_step":
      return text(step) &&
        STEP_KEY.test(step) &&
        label(raw.label) &&
        (raw.stepKind === "work" || raw.stepKind === "wait") &&
        seconds(raw.seconds)
        ? {
            kind,
            workflow,
            step,
            label: raw.label,
            stepKind: raw.stepKind,
            seconds: raw.seconds,
          }
        : null;
    case "add_decision":
      return text(step) && STEP_KEY.test(step) && label(raw.label)
        ? { kind, workflow, step, label: raw.label }
        : null;
    case "remove_node":
      return text(step) ? { kind, workflow, step } : null;
    case "connect":
      return text(from) && text(to) && outcome(raw.outcome)
        ? { kind, workflow, from, to, outcome: raw.outcome }
        : null;
    case "disconnect":
      return text(from) && text(to) ? { kind, workflow, from, to } : null;
    case "set_step": {
      const workers = raw.workers;
      const newLabel = raw.label;
      const newSeconds = raw.seconds;
      if (
        !text(step) ||
        (newLabel !== null && !label(newLabel)) ||
        (newSeconds !== null && !seconds(newSeconds)) ||
        (workers !== null &&
          (!Array.isArray(workers) ||
            workers.length === 0 ||
            !workers.every(text)))
      )
        return null;
      return {
        kind,
        workflow,
        step,
        label: newLabel,
        seconds: newSeconds,
        workers,
      };
    }
    default:
      return null;
  }
}

export type AppliedChanges =
  | Readonly<{ kind: "ready"; snapshot: DraftSnapshot }>
  | Readonly<{ kind: "refused"; problems: readonly DraftProblem[] }>;

/** The applied revision with these changes. It stores nothing and judges only the shape. */
export function applyWorkflowChanges(
  document: BakeryWorkflowDocument,
  changes: readonly WorkflowChange[],
): AppliedChanges {
  const seed = draftSeed(document);
  const nodes = new Map<string, DraftNode>();
  for (const node of seed.nodes) nodes.set(nodeId(node), node);
  const edges = new Map<string, DraftEdge>();
  for (const edge of seed.edges) edges.set(edgeKey(edge), edge);
  const workflows = new Set<string>();
  for (const workflow of document.workflows) workflows.add(workflow.id);
  const problems: DraftProblem[] = [];
  const snapshot = (): DraftSnapshot => ({
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    positions: seed.positions,
  });
  const has = (workflow: string, step: string): boolean => {
    if (nodes.has(draftNodeId(workflow, step))) return true;
    problems.push({
      node: null,
      message: `${workflow}/${step}: that step does not exist. Read the workflow again.`,
    });
    return false;
  };
  for (const change of changes) {
    if (!workflows.has(change.workflow)) {
      problems.push({
        node: null,
        message: `${change.workflow}: that workflow does not exist. Read the recipe again.`,
      });
      continue;
    }
    switch (change.kind) {
      case "add_step":
      case "add_decision": {
        const id = draftNodeId(change.workflow, change.step);
        if (nodes.has(id)) {
          problems.push({
            node: id,
            message: `${change.step}: a step with this key already exists.`,
          });
          break;
        }
        const node = newStepNode(document, snapshot(), {
          workflow: change.workflow,
          kind: change.kind === "add_decision" ? "decision" : change.stepKind,
          label: change.label,
          seconds: change.kind === "add_step" ? change.seconds : 1,
        });
        if (node === null) {
          problems.push({
            node: null,
            message: `${change.step}: this recipe cannot hold that step.`,
          });
          break;
        }
        nodes.set(id, { ...node, key: change.step });
        break;
      }
      case "remove_node":
        if (!has(change.workflow, change.step)) break;
        nodes.delete(draftNodeId(change.workflow, change.step));
        for (const [key, edge] of edges)
          if (
            edge.workflow === change.workflow &&
            (edge.from === change.step || edge.to === change.step)
          )
            edges.delete(key);
        break;
      case "connect": {
        if (
          !has(change.workflow, change.from) ||
          !has(change.workflow, change.to)
        )
          break;
        const edge: DraftEdge = {
          workflow: change.workflow,
          from: change.from,
          to: change.to,
          order: edges.size,
          branch: change.outcome,
        };
        edges.set(edgeKey(edge), edge);
        break;
      }
      case "disconnect": {
        const key = `${change.workflow}/${change.from}>${change.to}`;
        if (!edges.delete(key))
          problems.push({
            node: null,
            message: `${key}: that arrow does not exist.`,
          });
        break;
      }
      case "set_step": {
        if (!has(change.workflow, change.step)) break;
        const id = draftNodeId(change.workflow, change.step);
        const node = nodes.get(id);
        if (node === undefined) break;
        let body: DraftNode["body"] | null = node.body;
        if (change.seconds !== null && body !== null)
          body = withStepSeconds(body, change.seconds);
        if (change.workers !== null && body !== null)
          body = withStepWorkers(body, change.workers);
        if (body === null) {
          problems.push({
            node: id,
            message: `${change.step}: its seconds or workers come from a machine, so they cannot change here.`,
          });
          break;
        }
        nodes.set(id, { ...node, label: change.label ?? node.label, body });
        break;
      }
    }
  }
  return problems.length > 0
    ? { kind: "refused", problems }
    : { kind: "ready", snapshot: snapshot() };
}

function nodeId(node: DraftNode): string {
  return draftNodeId(node.workflow, node.key);
}

/** The steps that a difference touches, with both ends of each changed arrow. */
function touchedSteps(base: DraftSnapshot, other: DraftSnapshot): Set<string> {
  const diff = workflowDiff(base, other);
  const touched = new Set<string>([...diff.added, ...diff.changed]);
  for (const item of diff.removed) touched.add(item.id);
  for (const edge of other.edges)
    if (diff.addedEdges.has(edgeKey(edge))) {
      touched.add(draftNodeId(edge.workflow, edge.from));
      touched.add(draftNodeId(edge.workflow, edge.to));
    }
  for (const edge of diff.removedEdges) {
    touched.add(draftNodeId(edge.workflow, edge.from));
    touched.add(draftNodeId(edge.workflow, edge.to));
  }
  return touched;
}

/**
 * Steps that a proposal changes and that a person also changed in the shared draft.
 * The person's work wins: the proposal does not apply over it.
 */
export function proposalOverlap(
  base: DraftSnapshot,
  proposed: DraftSnapshot,
  draft: DraftSnapshot,
): readonly string[] {
  const person = touchedSteps(base, draft);
  const overlap = [];
  for (const id of touchedSteps(base, proposed))
    if (person.has(id)) overlap.push(id);
  return overlap;
}

/**
 * What the shared draft takes from an approved proposal. Everything else in the
 * draft stays, so a person's unapplied work on other steps survives.
 */
export function proposalDraftMerge(
  base: DraftSnapshot,
  proposed: DraftSnapshot,
): DraftChangeSet {
  const diff = workflowDiff(base, proposed);
  const put = proposed.nodes.filter(
    (node) => diff.added.has(nodeId(node)) || diff.changed.has(nodeId(node)),
  );
  const positions: Record<string, Readonly<{ x: number; y: number }>> = {};
  for (const id of diff.added) {
    const position = proposed.positions[id];
    if (position !== undefined) positions[id] = position;
  }
  // The person approved the layout that the review showed, so the steps that it
  // moved to make room move too. Otherwise an added step can cover another one.
  const moves: Record<string, DraftChangeSet["moves"][string]> = {};
  for (const [id, to] of Object.entries(proposed.positions)) {
    const from = base.positions[id];
    if (from !== undefined && (from.x !== to.x || from.y !== to.y))
      moves[id] = { from, to };
  }
  const proposedIds = new Set(proposed.nodes.map(nodeId));
  return {
    put,
    remove: base.nodes
      .filter((node) => !proposedIds.has(nodeId(node)))
      .map(nodeKeyOf),
    putEdges: proposed.edges.filter((edge) =>
      diff.addedEdges.has(edgeKey(edge)),
    ),
    removeEdges: diff.removedEdges,
    positions,
    moves,
  };
}

function nodeKeyOf(
  node: DraftNode,
): Readonly<{ workflow: string; key: string }> {
  return { workflow: node.workflow, key: node.key };
}

export type ProposalChangeSummary = Readonly<{
  added: readonly string[];
  changed: readonly string[];
  removed: readonly string[];
  arrows: number;
}>;

/** A proposal's change in words that come from the diff, never from a model. */
export function proposalChangeSummary(
  base: DraftSnapshot,
  proposed: DraftSnapshot,
): ProposalChangeSummary {
  const diff = workflowDiff(base, proposed);
  const added = [];
  const changed = [];
  for (const node of proposed.nodes) {
    if (diff.added.has(nodeId(node))) added.push(node.label);
    if (diff.changed.has(nodeId(node))) changed.push(node.label);
  }
  return {
    added,
    changed,
    removed: diff.removed.map(removedLabel),
    arrows: diff.addedEdges.size + diff.removedEdges.length,
  };
}

function removedLabel(item: Readonly<{ label: string }>): string {
  return item.label;
}

export function parseProposalChangeSummary(
  raw: unknown,
): ProposalChangeSummary | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["added", "changed", "removed", "arrows"]) ||
    !stringList(raw.added) ||
    !stringList(raw.changed) ||
    !stringList(raw.removed) ||
    typeof raw.arrows !== "number"
  )
    return null;
  return {
    added: raw.added,
    changed: raw.changed,
    removed: raw.removed,
    arrows: raw.arrows,
  };
}

function stringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
