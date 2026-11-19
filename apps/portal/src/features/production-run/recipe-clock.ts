import { stepSeconds, workflowDiff } from "@purin-labs/bakery-workflow/draft";
import {
  draftNodeId,
  type DraftNode,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";
import type { StageBinding } from "./recipe-graph";

/**
 * Plan 84 D2: the fixed animations stay, and they show a draft as far as they can.
 * A changed duration stretches its stage, and an added step holds the scene. A
 * removed or reordered step has no matching animation, so the view says so. The
 * engine's comparison stays the record of the draft's result: the animation is a
 * view, and it takes its proportions from the draft's durations.
 */
export type AnimationSegment = Readonly<{
  modelStartS: number;
  modelEndS: number;
  runStartS: number;
  runEndS: number;
  /** An added step that the scene holds for. */
  hold: string | null;
}>;

export type AnimationPlan =
  | Readonly<{ kind: "original" }>
  | Readonly<{ kind: "mismatch" }>
  | Readonly<{ kind: "warped"; segments: readonly AnimationSegment[] }>;

export const ORIGINAL_ANIMATION: AnimationPlan = { kind: "original" };

type Stage = Readonly<{ id: string; startS: number; endS: number }>;

export type AnimationPlanBuilder = (stages: readonly Stage[]) => AnimationPlan;

/** The longest hold, in animation seconds. An added step can be hours long. */
const MAX_HOLD_S = 10;

function nodeOf(snapshot: DraftSnapshot, key: string): DraftNode | null {
  for (const node of snapshot.nodes) if (node.key === key) return node;
  return null;
}

export function animationPlan(
  stages: readonly Stage[],
  binding: StageBinding,
  base: DraftSnapshot,
  current: DraftSnapshot,
  /** Task keys that the run's decision skipped. Their stage takes no time. */
  skipped: ReadonlySet<string> = new Set(),
): AnimationPlan {
  const diff = workflowDiff(base, current);
  const bound = new Set<string>();
  for (const keys of Object.values(binding))
    for (const key of keys) bound.add(key);
  const firstStage = new Map<string, number>();
  stages.forEach((stage, index) => {
    for (const key of binding[stage.id] ?? [])
      if (!firstStage.has(key)) firstStage.set(key, index);
  });
  for (const removed of diff.removed)
    if (bound.has(removed.id.slice(removed.id.indexOf("/") + 1)))
      return { kind: "mismatch" };
  // An edge that this view can see must not ask a later stage to come first.
  for (const edge of current.edges) {
    const from = firstStage.get(edge.from);
    const to = firstStage.get(edge.to);
    if (from !== undefined && to !== undefined && from > to)
      return { kind: "mismatch" };
  }
  const scales = new Map<string, number>();
  for (const stage of stages) {
    let before = 0;
    let after = 0;
    for (const key of binding[stage.id] ?? []) {
      const was = nodeOf(base, key);
      const now = nodeOf(current, key);
      if (was === null || now === null) continue;
      before += stepSeconds(was.body) ?? 0;
      after += stepSeconds(now.body) ?? 0;
    }
    const keys = binding[stage.id] ?? [];
    const jumped = keys.length > 0 && keys.every(skipped.has.bind(skipped));
    scales.set(
      stage.id,
      jumped ? 0 : before > 0 && after > 0 ? after / before : 1,
    );
  }
  const holds = new Map<string, { label: string; seconds: number }[]>();
  for (const id of diff.added) {
    const node = current.nodes.find(nodeHasId.bind(null, id));
    if (node === undefined) continue;
    const stage = stageOfAdded(stages, firstStage, current, node);
    if (stage === null) continue;
    const list = holds.get(stage.id) ?? [];
    const scale = stageScale(stage, binding, base);
    list.push({
      label: node.label,
      seconds: Math.min(MAX_HOLD_S, (stepSeconds(node.body) ?? 0) * scale),
    });
    holds.set(stage.id, list);
  }
  if (holds.size === 0 && [...scales.values()].every(isOne))
    return { kind: "original" };
  const segments: AnimationSegment[] = [];
  let run = stages[0]?.startS ?? 0;
  for (const stage of stages) {
    const scale = scales.get(stage.id) ?? 1;
    const end = onGrid(run + (stage.endS - stage.startS) * scale);
    segments.push({
      modelStartS: stage.startS,
      modelEndS: stage.endS,
      runStartS: run,
      runEndS: end,
      hold: null,
    });
    run = end;
    for (const hold of holds.get(stage.id) ?? []) {
      const held = onGrid(run + hold.seconds);
      segments.push({
        modelStartS: stage.endS,
        modelEndS: stage.endS,
        runStartS: run,
        runEndS: held,
        hold: hold.label,
      });
      run = held;
    }
  }
  return { kind: "warped", segments };
}

/** 0.2 s is a whole number of steps of each model, so a seek lands on a boundary. */
function onGrid(seconds: number): number {
  return Math.round(seconds * 5) / 5;
}

/** The run clock adds decimal steps. This keeps it on them. */
export function steppedRun(runS: number, stepS: number, endS: number): number {
  return Math.min(endS, Number((runS + stepS).toFixed(3)));
}

function isOne(value: number): boolean {
  return value === 1;
}

function nodeHasId(id: string, node: DraftNode): boolean {
  return draftNodeId(node.workflow, node.key) === id;
}

/** Animation seconds for each recipe second of the stage. */
function stageScale(
  stage: Stage,
  binding: StageBinding,
  base: DraftSnapshot,
): number {
  let recipe = 0;
  for (const key of binding[stage.id] ?? []) {
    const node = nodeOf(base, key);
    if (node !== null) recipe += stepSeconds(node.body) ?? 0;
  }
  return recipe > 0 ? (stage.endS - stage.startS) / recipe : 1;
}

/** An added step holds after the last stage that it needs, or else after the first. */
function stageOfAdded(
  stages: readonly Stage[],
  firstStage: ReadonlyMap<string, number>,
  snapshot: DraftSnapshot,
  node: DraftNode,
): Stage | null {
  let index = -1;
  for (const edge of snapshot.edges)
    if (edge.to === node.key && edge.workflow === node.workflow)
      index = Math.max(index, firstStage.get(edge.from) ?? -1);
  return stages[Math.max(index, 0)] ?? null;
}

export function modelTime(plan: AnimationPlan, runS: number): number {
  if (plan.kind !== "warped") return runS;
  for (const segment of plan.segments) {
    if (runS > segment.runEndS) continue;
    const span = segment.runEndS - segment.runStartS;
    if (span <= 0) return segment.modelEndS;
    const progress = Math.max(0, runS - segment.runStartS) / span;
    return (
      segment.modelStartS + progress * (segment.modelEndS - segment.modelStartS)
    );
  }
  return plan.segments.at(-1)?.modelEndS ?? runS;
}

export function runEnd(plan: AnimationPlan, modelEndS: number): number {
  return plan.kind === "warped"
    ? (plan.segments.at(-1)?.runEndS ?? modelEndS)
    : modelEndS;
}

export function holdAt(plan: AnimationPlan, runS: number): string | null {
  if (plan.kind !== "warped") return null;
  for (const segment of plan.segments)
    if (
      segment.hold !== null &&
      runS >= segment.runStartS &&
      runS < segment.runEndS
    )
      return segment.hold;
  return null;
}

/** The stage windows on the run's clock. */
export function warpedStages<S extends Stage>(
  stages: readonly S[],
  plan: AnimationPlan,
): readonly S[] {
  if (plan.kind !== "warped") return stages;
  const result: S[] = [];
  for (const stage of stages)
    for (const segment of plan.segments)
      if (
        segment.hold === null &&
        segment.modelStartS === stage.startS &&
        segment.modelEndS === stage.endS
      )
        result.push({
          ...stage,
          startS: segment.runStartS,
          endS: segment.runEndS,
        });
  return result;
}

export type RecipeEngine<Sample> = Readonly<{
  initialSample(): Sample;
  stepBatch(steps: number): readonly Sample[];
}>;

/**
 * The engine that a view drives, on the run's clock. It advances the model as far
 * as the plan allows, and it repeats the last sample during a hold. A sample keeps
 * its model state and carries the run's time, so the view's history and seek work
 * unchanged. Without a warped plan the view drives the model's own engine.
 */
export function warpedEngine<Sample extends Readonly<{ timeS: number }>>(
  engine: RecipeEngine<Sample>,
  plan: AnimationPlan,
  stepS: number,
): RecipeEngine<Sample> {
  if (plan.kind !== "warped") return engine;
  let runS = 0;
  let modelSteps = 0;
  let last = engine.initialSample();
  const finalRun = runEnd(plan, 0);
  return {
    initialSample(): Sample {
      return { ...last, timeS: 0 };
    },
    stepBatch(steps: number): readonly Sample[] {
      const out: Sample[] = [];
      for (let index = 0; index < steps; index++) {
        runS = steppedRun(runS, stepS, finalRun);
        const wanted = Math.round(modelTime(plan, runS) / stepS);
        // The final model steps also run, so the model reports its own outcome.
        const count =
          runS >= finalRun
            ? Math.max(wanted - modelSteps, 1)
            : wanted - modelSteps;
        if (count > 0) {
          const batch = engine.stepBatch(count);
          modelSteps += batch.length;
          const newest = batch.at(-1);
          if (newest !== undefined) last = newest;
        }
        out.push({ ...last, timeS: runS });
        if ((last as Readonly<{ outcome?: unknown }>).outcome != null) break;
      }
      return out;
    },
  };
}
