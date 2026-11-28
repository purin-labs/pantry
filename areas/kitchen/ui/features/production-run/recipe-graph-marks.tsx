import {
  stepWorkers,
  type DraftProblem,
  type WorkflowDiff,
} from "@purin-labs/bakery-workflow/draft";
import type { RunFinding } from "@purin-labs/bakery-workflow/findings";
import type { TaskView } from "@purin-labs/production-simulation";
import {
  draftNodeId,
  type DraftNode,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";
import {
  Bot,
  Check,
  CircleAlert,
  Cog,
  GitBranch,
  Layers,
  Timer,
  User,
  X,
} from "lucide-react";
import React from "react";
import { graphChoice, type GraphChoice } from "./recipe-graph-select";
import { animationPlan, type AnimationPlanBuilder } from "./recipe-clock";
import type { DraftComparison } from "./recipe-draft-run";
import type {
  RecipeOverviewNode,
  RecipeGraph,
  RecipeGraphNode,
  RecipeSource,
} from "./recipe-graph";
import { taskSpans, type Span } from "./oven-task-views";
import { seconds } from "./oven-logistics";
import type { ProposalDecision } from "./recipe-workspace";
import { wireRoute } from "./recipe-graph-wires";
import type { PortKind } from "./recipe-graph-wires";

export type RecipeGraphStage = Readonly<{
  id: string;
  /** The stage's card state, which a step shows as its own. */
  state: string;
  stateLabel: string;
  startS: number;
  endS: number;
  reached: boolean;
}>;

export function buildPlan(
  binding: NonNullable<RecipeSource["binding"]>,
  base: DraftSnapshot,
  snapshot: DraftSnapshot,
  skipped: ReadonlySet<string>,
  stages: Parameters<AnimationPlanBuilder>[0],
): ReturnType<AnimationPlanBuilder> {
  return animationPlan(stages, binding, base, snapshot, skipped);
}

/**
 * One lane for each task that ran, named by its step. A task of a step that the
 * draft added takes the accent, so the reader finds the change on the timeline.
 */
export function taskTimeline(
  tasks: readonly TaskView[],
  end: number,
  run: "Draft" | "Proposal",
  graph: RecipeGraph,
  diff: WorkflowDiff,
): React.ReactNode {
  const steps = new Map<string, RecipeGraphNode>();
  for (const node of graph.nodes) steps.set(node.key, node);
  const horizon = Math.max(end, 1);
  const rows: React.ReactNode[] = [];
  for (const task of tasks) {
    const spans = taskSpans(task, end);
    if (spans.length === 0) continue;
    const step =
      task.subject.kind === "workflow"
        ? steps.get(task.subject.key)
        : undefined;
    const name = step?.label ?? task.id;
    rows.push(
      <li
        key={task.id}
        data-timeline-task={task.id}
        data-added={step !== undefined && diff.added.has(step.id)}
      >
        <span title={task.id}>{name}</span>
        <span className="recipe-graph-lane">
          {spans.map(timelineBar.bind(null, name, horizon, step))}
        </span>
      </li>,
    );
  }
  return (
    <section aria-label="Task timeline">
      <header>
        <h3>Task timeline</h3>
        <span>
          {run} · 0–{Number(seconds(end)).toFixed(1)} s
        </span>
      </header>
      <ol className="recipe-graph-timeline">{rows}</ol>
    </section>
  );
}

function timelineBar(
  name: string,
  horizon: number,
  step: RecipeGraphNode | undefined,
  span: Span,
): React.ReactNode {
  const from = Number(seconds(span.start)).toFixed(1);
  const to = Number(seconds(span.end)).toFixed(1);
  return (
    <span
      key={span.phase}
      className="recipe-graph-bar"
      data-kind={step?.role ?? "work"}
      data-phase={span.phase}
      title={`${name}: ${span.phase} ${from}–${to} s`}
      style={{
        insetInlineStart: `${(span.start / horizon) * 100}%`,
        width: `${((span.end - span.start) / horizon) * 100}%`,
      }}
    >
      <span className="recipe-graph-hidden">
        {span.phase} {from}–{to} s
      </span>
    </span>
  );
}

/** Steps that a decision skipped in every instance of the run. */
export function skippedKeys(run: DraftComparison["draft"]): ReadonlySet<string> {
  const skipped = new Set<string>();
  const ran = new Set<string>();
  if (run.logistics.kind === "available")
    for (const task of run.logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      (task.kind === "skipped" ? skipped : ran).add(task.subject.key);
    }
  for (const key of ran) skipped.delete(key);
  return skipped;
}

export function overviewEdge(
  places: ReadonlyMap<string, RecipeOverviewNode>,
  edge: Readonly<{ from: string; to: string }>,
): React.ReactNode {
  const from = places.get(edge.from);
  const to = places.get(edge.to);
  if (from === undefined || to === undefined) return null;
  return (
    <g key={`${edge.from} ${edge.to}`} data-kind="workflow">
      <path d={wireRoute(from, to).d} />
    </g>
  );
}

export function ignoreFailure(): void {}

export function decisionText(decision: ProposalDecision): string {
  switch (decision.kind) {
    case "approved":
      return `Applied revision ${String(decision.revision)}. New runs use it.`;
    case "declined":
      return "You declined the proposal. Nothing changed.";
    case "stale":
      return "The recipe changed after this proposal, so it did not apply. Ask the agent again.";
    case "human_intervention":
      return "A person changed the same steps in the draft, so the proposal did not apply. Apply or undo that work, and ask the agent again.";
    case "closed":
      return "This proposal is already closed.";
  }
}

export function findingItem(finding: RunFinding): React.ReactNode {
  return <li key={finding.id}>{findingText(finding)}</li>;
}

export function findingText(finding: RunFinding): string {
  switch (finding.kind) {
    case "late_order":
      return finding.waitSeconds === null
        ? `${finding.subject} did not finish.`
        : `${finding.subject} waited ${Math.round(finding.waitSeconds)} s.`;
    case "decision_rejected":
      return `${finding.subject}: the decision rejected.`;
    case "task_failed":
    case "recovery_failed":
      return `${finding.subject} failed at ${Math.round(finding.atSeconds)} s.`;
    case "run_blocked":
      return `The run stopped at ${Math.round(finding.atSeconds)} s. It needs ${finding.subject}.`;
  }
}

export function changeItem(kind: string, label: string): React.ReactNode {
  return (
    <li key={`${kind}/${label}`}>
      {kind}: {label}
    </li>
  );
}

export function simulatedText(comparison: DraftComparison): string {
  const { applied, draft } = comparison;
  const parts = [
    `Simulated. End ${applied.endSeconds.toFixed(1)} s → ${draft.endSeconds.toFixed(1)} s.`,
  ];
  if (applied.orders + draft.orders > 0)
    parts.push(`Late orders ${applied.lateOrders} → ${draft.lateOrders}.`);
  return parts.join(" ");
}

export function workflowChoice(workflow: Readonly<{ id: string }>): GraphChoice {
  return graphChoice(workflow.id);
}

export function trimmed(text: string): string {
  return text.trim();
}

export function isOutcome(text: string): text is "accept" | "reject" {
  return text === "accept" || text === "reject";
}

export function isOtherThan(worker: string, item: string): boolean {
  return item !== worker;
}

export function nodeMatches(id: string | null, node: DraftNode): boolean {
  return id !== null && draftNodeId(node.workflow, node.key) === id;
}

export function graphNodeMatches(id: string, node: RecipeGraphNode): boolean {
  return node.id === id;
}

export function problemIsAt(id: string, problem: DraftProblem): boolean {
  return problem.node === id;
}

export function removedLabel(item: Readonly<{ label: string }>): string {
  return item.label;
}

export function problemItem(problem: DraftProblem, index: number): React.ReactNode {
  return <li key={index}>{problem.message}</li>;
}

export function port(side: "in" | "out", kind: PortKind): React.ReactNode {
  return (
    <span
      className="recipe-graph-port"
      data-side={side}
      data-kind={kind}
      aria-hidden="true"
    >
      {portIcon(kind, 10)}
    </span>
  );
}

/** The tile on a card names its kind in the same hue as its ports. */
export function kindIcon(kind: PortKind): React.ReactNode {
  return (
    <span className="recipe-graph-kind" data-kind={kind} aria-hidden="true">
      {portIcon(kind, 16)}
    </span>
  );
}

export function portIcon(kind: PortKind, size = 12): React.ReactNode {
  switch (kind) {
    case "work":
      return <User size={size} strokeWidth={2} />;
    case "process":
      return <Timer size={size} strokeWidth={2} />;
    case "machine":
      return <Cog size={size} strokeWidth={2} />;
    case "robot":
      return <Bot size={size} strokeWidth={2} />;
    case "check":
      return <GitBranch size={size} strokeWidth={2} />;
    case "accept":
      return <Check size={size} strokeWidth={2} />;
    case "reject":
      return <X size={size} strokeWidth={2} />;
    case "workflow":
      return <Layers size={size} strokeWidth={2} />;
  }
}

/** The corner mark repeats the state word, so a run reads at a glance. */
export function stateMark(state: string): React.ReactNode {
  switch (state) {
    case "current":
      return (
        <span
          className="recipe-graph-mark"
          data-mark="current"
          aria-hidden="true"
        />
      );
    case "done":
      return (
        <span className="recipe-graph-mark" data-mark="done" aria-hidden="true">
          <Check size={10} strokeWidth={3} />
        </span>
      );
    case "failed":
      return (
        <span
          className="recipe-graph-mark"
          data-mark="failed"
          aria-hidden="true"
        >
          <CircleAlert size={14} strokeWidth={2.25} />
        </span>
      );
    default:
      return null;
  }
}

export function stageMatches(
  node: Readonly<{ stages: readonly string[] }>,
  stage: RecipeGraphStage,
): boolean {
  return node.stages.includes(stage.id);
}

/** A step that spans several stages runs from its first until its last is done. */
export function nodeState(
  stages: readonly RecipeGraphStage[],
): Pick<RecipeGraphStage, "state" | "stateLabel"> {
  for (const wanted of ["failed", "current"]) {
    const found = stages.find(stageInState.bind(null, wanted));
    if (found !== undefined) return found;
  }
  const done = stages.filter(stageInState.bind(null, "done"));
  const last = stages.at(-1);
  if (last === undefined) return { state: "not-started", stateLabel: "" };
  if (done.length === stages.length || done.length === 0) return last;
  return { state: "current", stateLabel: "Current" };
}

function stageInState(state: string, stage: RecipeGraphStage): boolean {
  return stage.state === state;
}

/** Who or what does a step: its workers, or else the equipment that it holds. */
export function stepDoer(body: DraftNode["body"]): string {
  const workers = stepWorkers(body);
  if (workers !== null && workers.length > 0) return workers.join(", ");
  const held: string[] = [];
  if (Array.isArray(body.claims))
    for (const claim of body.claims as readonly unknown[])
      if (
        typeof claim === "object" &&
        claim !== null &&
        typeof (claim as { resource?: unknown }).resource === "string"
      )
        held.push((claim as { resource: string }).resource);
  return held.join(", ");
}

export function secondsText(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
  if (seconds < 3600) return `${Number((seconds / 60).toFixed(1))} min`;
  return `${Number((seconds / 3600).toFixed(1))} h`;
}

export function roleLabel(role: RecipeGraphNode["role"]): string {
  switch (role) {
    case "work":
      return "Work";
    case "process":
      return "Process";
    case "machine":
      return "Machine";
    case "robot":
      return "Robot";
    case "check":
      return "Check";
    case "accept":
      return "If accepted";
    case "reject":
      return "If rejected";
  }
}
