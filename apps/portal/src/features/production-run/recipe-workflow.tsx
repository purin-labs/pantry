import {
  ArrowLeft,
  ChartGantt,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import React from "react";
import { SegmentedControl } from "../workflow-simulator/docks/shared";
import {
  holdAt,
  type AnimationPlan,
  type AnimationPlanBuilder,
} from "./recipe-clock";
import type { RecipeGraphSource } from "./recipe-graph";
import {
  RecipeWorkflowGraph,
  type RecipeGraphStage,
} from "./recipe-workflow-graph";
import { useLive, useLiveEffect } from "./shared/live";
import { sameItems, type LiveSource } from "./shared/live-value";

/** The simulation clock of a recipe run, and the latest time a seek can reach. */
export type RecipeClock = Readonly<{ timeS: number; reachedS: number }>;

export type RecipeSurface = "factory" | "workflow" | "split";

const SPLIT_STORAGE_KEY = "satyr-recipe-split-percent";
const DEFAULT_SPLIT_PERCENT = 48;
const MIN_SPLIT_PERCENT = 30;
const MAX_SPLIT_PERCENT = 68;
const COMPACT_MEDIA_QUERY = "(max-width: 840px)";
const MIN_SPLIT_WORKSPACE_WIDTH = 840;

type Stage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

type StageState = "not-started" | "current" | "done" | "failed" | "not-reached";

type WorkflowProps = Readonly<{
  graph: RecipeGraphSource;
  /** Receives the plan of a draft that ran, for the view's own original stages. */
  planned?: (plan: AnimationPlanBuilder) => void;
  stages: readonly Stage[];
  /** The playback clock; the cards read only stage changes from it. */
  clock: LiveSource<RecipeClock>;
  running: boolean;
  /** The run has not started, or a seek returned it to its prepared state. */
  prepared: boolean;
  outcome: "completed" | "failed" | null;
  seek: (timeS: number) => void;
}>;

export function RecipeSurfaceSwitch(
  props: Readonly<{
    value: RecipeSurface;
    select: (surface: RecipeSurface) => void;
    allowSplit?: boolean;
  }>,
): React.ReactNode {
  const anchor = React.useRef<HTMLSpanElement>(null);
  const compact = useCompactRecipeViewport(anchor);
  const canSplit = (props.allowSplit ?? true) && !compact;

  React.useEffect(() => {
    if (!canSplit && props.value === "split") {
      props.select("factory");
    }
  }, [canSplit, props]);

  const options = canSplit
    ? [
        {
          value: "factory" as const,
          label: "Factory",
          onSelect: props.select.bind(null, "factory"),
        },
        {
          value: "workflow" as const,
          label: "Workflow",
          onSelect: props.select.bind(null, "workflow"),
        },
        {
          value: "split" as const,
          label: "Split",
          onSelect: props.select.bind(null, "split"),
        },
      ]
    : [
        {
          value: "factory" as const,
          label: "Factory",
          onSelect: props.select.bind(null, "factory"),
        },
        {
          value: "workflow" as const,
          label: "Workflow",
          onSelect: props.select.bind(null, "workflow"),
        },
      ];

  return (
    <span ref={anchor} style={{ display: "contents" }}>
      <SegmentedControl
        ariaLabel="Surface view"
        role="group"
        value={!canSplit && props.value === "split" ? "factory" : props.value}
        options={options}
      />
    </span>
  );
}

/** Resizable vertical divider between the left Workflow slot and the right 3D Factory view. */
export function RecipeSplitDivider(
  props: Readonly<{ surface: RecipeSurface }>,
): React.ReactNode {
  const ref = React.useRef<HTMLDivElement>(null);
  const [percent, setPercent] = React.useState<number>(readSplitPercent);
  const [dragging, setDragging] = React.useState(false);

  React.useLayoutEffect(() => {
    if (props.surface !== "split") return;
    const workspace = ref.current?.closest<HTMLElement>(
      ".persistent-production",
    );
    if (workspace === null || workspace === undefined) return;
    workspace.style.setProperty("--recipe-split-percent", `${percent}%`);
  }, [props.surface, percent]);

  if (props.surface !== "split") return null;

  function applyPercent(next: number, persist: boolean): void {
    const clamped = clampSplitPercent(next);
    setPercent(clamped);
    if (persist) rememberSplitPercent(clamped);
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const workspace = event.currentTarget.closest<HTMLElement>(
      ".persistent-production",
    );
    const bounds = workspace?.getBoundingClientRect();
    if (bounds === undefined || bounds.width <= 0) return;
    applyPercent(((event.clientX - bounds.left) / bounds.width) * 100, false);
  }

  function finishResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    rememberSplitPercent(percent);
  }

  function keyResize(event: React.KeyboardEvent<HTMLDivElement>): void {
    let next = percent;
    switch (event.key) {
      case "ArrowLeft":
        next -= 4;
        break;
      case "ArrowRight":
        next += 4;
        break;
      case "Home":
        next = MIN_SPLIT_PERCENT;
        break;
      case "End":
        next = MAX_SPLIT_PERCENT;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyPercent(next, true);
  }

  return (
    <div
      ref={ref}
      className="factory-split-divider"
      data-resize-handle=""
      data-dragging={dragging || undefined}
      role="separator"
      tabIndex={0}
      aria-label="Resize workflow pane"
      aria-orientation="vertical"
      aria-valuemin={MIN_SPLIT_PERCENT}
      aria-valuemax={MAX_SPLIT_PERCENT}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={`${Math.round(percent)}%`}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onKeyDown={keyResize}
      onDoubleClick={() => applyPercent(DEFAULT_SPLIT_PERCENT, true)}
    />
  );
}

function useCompactRecipeViewport(
  anchor: React.RefObject<HTMLElement | null>,
): boolean {
  const [compact, setCompact] = React.useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia(COMPACT_MEDIA_QUERY).matches
      : false,
  );
  React.useEffect(() => {
    const media = window.matchMedia(COMPACT_MEDIA_QUERY);
    const workspace = anchor.current?.closest<HTMLElement>(
      ".persistent-production",
    );
    const update = (): void => {
      const narrowWorkspace =
        workspace !== null &&
        workspace !== undefined &&
        workspace.offsetWidth > 0 &&
        workspace.offsetWidth <= MIN_SPLIT_WORKSPACE_WIDTH;
      setCompact(media.matches || narrowWorkspace);
    };
    update();
    media.addEventListener("change", update);
    const observer =
      workspace !== null &&
      workspace !== undefined &&
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(update)
        : null;
    if (observer !== null && workspace !== null && workspace !== undefined) {
      observer.observe(workspace);
    }
    return () => {
      media.removeEventListener("change", update);
      observer?.disconnect();
    };
  }, [anchor]);
  return compact;
}

function clampSplitPercent(value: number): number {
  return Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, value));
}

function readSplitPercent(): number {
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    if (raw === null) return DEFAULT_SPLIT_PERCENT;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampSplitPercent(parsed)
      : DEFAULT_SPLIT_PERCENT;
  } catch {
    return DEFAULT_SPLIT_PERCENT;
  }
}

function rememberSplitPercent(value: number): void {
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(value)));
  } catch {
    /* Session state holds the width when storage is unavailable. */
  }
}

/** The way back to the recipe list, at the start of the workspace header. */
export function RecipeBackButton(
  props: Readonly<{ close: () => void }>,
): React.ReactNode {
  return (
    <button
      type="button"
      className="factory-back"
      aria-label="Back to recipes"
      title="Back to recipes"
      onClick={props.close}
    >
      <ArrowLeft size={18} aria-hidden="true" />
    </button>
  );
}

/** The icon at the start of the run control. Its words name the action. */
export function RunIcon(
  props: Readonly<{ action: "start" | "pause" | "again" }>,
): React.ReactNode {
  switch (props.action) {
    case "start":
      return <Play size={14} fill="currentColor" aria-hidden="true" />;
    case "pause":
      return <Pause size={14} fill="currentColor" aria-hidden="true" />;
    case "again":
      return <RotateCcw size={14} aria-hidden="true" />;
  }
}

/** The face of the footer Timeline toggle; the caret shows where it opens. */
export function TimelineLabel(
  props: Readonly<{ open: boolean }>,
): React.ReactNode {
  return (
    <>
      <ChartGantt size={14} aria-hidden="true" />
      <span>Timeline</span>
      {props.open ? (
        <ChevronDown size={14} aria-hidden="true" />
      ) : (
        <ChevronUp size={14} aria-hidden="true" />
      )}
    </>
  );
}

/** Presentation only. The stage times and the simulation clock stay with the workspace. */
export function RecipeWorkflow(props: WorkflowProps): React.ReactNode {
  // A card changes at a stage boundary, not on each playback frame.
  const cards = useLive(
    props.clock,
    (clock) => props.stages.map(cardKey.bind(null, props, clock)),
    sameItems,
  );
  const stages = props.stages.map((stage, index) =>
    stageView(props, stage, index, cards[index] ?? ""),
  );
  return (
    <section className="recipe-workflow" aria-label="Recipe workflow">
      <h3>Workflow</h3>
      <p>Select a stage that has run to move the simulation to its start.</p>
      <ol>{stages.map(stageCard.bind(null, props))}</ol>
      <RecipeWorkflowGraph
        source={props.graph}
        stages={stages.map(graphStage.bind(null, props))}
        seek={props.seek}
        planned={props.planned}
      />
    </section>
  );
}

/** What the scene cannot show of a draft. It shows nothing for the original recipe. */
export function RecipeAnimationNotice(
  props: Readonly<{ plan: AnimationPlan; clock: LiveSource<RecipeClock> }>,
): React.ReactNode {
  const hold = useLive(props.clock, (clock) =>
    props.plan.kind === "mismatch" ? null : holdAt(props.plan, clock.timeS),
  );
  if (props.plan.kind === "mismatch")
    return (
      <p className="recipe-animation-notice" role="status">
        This animation shows the original recipe.
      </p>
    );
  return hold === null ? null : (
    <p className="recipe-animation-notice" role="status">
      Added step, no animation: {hold}
    </p>
  );
}

type StageView = Readonly<{
  stage: Stage;
  index: number;
  last: boolean;
  state: StageState;
  reached: boolean;
}>;

function cardKey(
  props: WorkflowProps,
  clock: RecipeClock,
  stage: Stage,
  index: number,
): string {
  const state = stageState(
    props,
    clock,
    stage,
    index === props.stages.length - 1,
  );
  return `${state}:${stage.startS <= clock.reachedS}`;
}

function stageView(
  props: WorkflowProps,
  stage: Stage,
  index: number,
  key: string,
): StageView {
  const [state, reached] = key.split(":");
  return {
    stage,
    index,
    last: index === props.stages.length - 1,
    state: state as StageState,
    reached: reached === "true",
  };
}

function graphStage(props: WorkflowProps, view: StageView): RecipeGraphStage {
  return {
    id: view.stage.id,
    state: view.state,
    stateLabel: stateLabel(view.state, props.running),
    startS: view.stage.startS,
    endS: view.stage.endS,
    reached: view.reached,
  };
}

function stageCard(props: WorkflowProps, view: StageView): React.ReactNode {
  const { stage, index, last, state } = view;
  return (
    <li key={stage.id} data-stage={stage.id} data-state={state}>
      <button
        type="button"
        aria-current={state === "current" ? "step" : undefined}
        disabled={!view.reached}
        onClick={props.seek.bind(null, stage.startS)}
      >
        <span className="recipe-workflow-meta">
          <span>
            Stage {index + 1} · {stage.startS.toFixed(0)}–
            {stage.endS.toFixed(0)} s
          </span>
          <span className="recipe-workflow-state">
            {stateIcon(state)}
            {stateLabel(state, props.running)}
          </span>
        </span>
        <strong>{stage.label.replace(/^\d+ · /u, "")}</strong>
        {state === "current" && (
          <StageProgress clock={props.clock} stage={stage} />
        )}
      </button>
      {!last && (
        <svg
          className="recipe-workflow-arrow"
          width="16"
          height="28"
          viewBox="0 0 16 28"
          aria-hidden="true"
        >
          <path d="M 8 1 L 8 27" />
        </svg>
      )}
    </li>
  );
}

/** The progress of the current stage follows the clock by a DOM write. */
function StageProgress(
  props: Readonly<{ clock: LiveSource<RecipeClock>; stage: Stage }>,
): React.ReactNode {
  const bar = React.useRef<HTMLProgressElement>(null);
  useLiveEffect(props.clock, (clock) => {
    const { startS, endS } = props.stage;
    if (bar.current !== null)
      bar.current.value =
        (Math.min(clock.timeS, endS) - startS) / (endS - startS);
  });
  return <progress ref={bar} aria-label="Stage progress" max={1} />;
}

/** The last stage stays current until the simulation reports its outcome. */
function stageState(
  props: WorkflowProps,
  clock: RecipeClock,
  stage: Stage,
  last: boolean,
): StageState {
  if (props.outcome === "completed") return "done";
  if (clock.timeS < stage.startS)
    return props.outcome === "failed" ? "not-reached" : "not-started";
  if (clock.timeS >= stage.endS && !last) return "done";
  if (props.outcome === "failed") return "failed";
  return props.prepared ? "not-started" : "current";
}

function stateLabel(state: StageState, running: boolean): string {
  switch (state) {
    case "not-started":
      return "Not started";
    case "current":
      return running ? "Running" : "Current";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "not-reached":
      return "Not reached";
  }
}

function stateIcon(state: StageState): React.ReactNode {
  switch (state) {
    case "done":
      return <Check size={14} aria-hidden="true" />;
    case "failed":
      return <CircleAlert size={14} aria-hidden="true" />;
    default:
      return null;
  }
}
