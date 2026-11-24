import React from "react";
import { X } from "lucide-react";
import {
  RecipeAnimationNotice,
  RecipeBackButton,
  RecipeSplitDivider,
  RecipeSurfaceSwitch,
  RecipeWorkflow,
  RunIcon,
  type RecipeClock,
  type RecipeSurface,
} from "../recipe-workflow";
import {
  runEnd,
  warpedStages,
  type AnimationPlan,
  type AnimationPlanBuilder,
  type RecipeEngine,
} from "../recipe-clock";
import type { RecipeGraphSource } from "../recipe-graph";
import { RecipeRunFooter } from "../recipe-run-footer";
import {
  RecipePlayback,
  type RecipeFrames,
  type RecipeRunSample,
  type RecipeRunState,
  type RecipeRunStatus,
} from "./playback-controller";
import type { LiveSource } from "./live-value";

type RecipePanel = "scenario" | "results";

/** What a person changes in a workspace: the surface, the open panel and the timeline. */
export type RecipeWorkspaceView = Readonly<{
  surface: RecipeSurface;
  panel: RecipePanel | null;
  timeline: boolean;
}>;

export const RECIPE_WORKSPACE_VIEW: RecipeWorkspaceView = {
  surface: "factory",
  panel: null,
  timeline: false,
};

type FooterProps = React.ComponentProps<typeof RecipeRunFooter>;

type LayoutProps = Readonly<{
  view: RecipeWorkspaceView;
  change(view: RecipeWorkspaceView): void;
  close(): void;
  status: string;
  clock: LiveSource<RecipeClock>;
  stages: FooterProps["stages"];
  seek(timeS: number): void;
  /** The animation of a draft, for the scene notice. A replay has none. */
  animation?: AnimationPlan;
  scene: React.ReactNode;
  title: React.ReactNode;
  /** More buttons after Scenario and Results. */
  pills?: React.ReactNode;
  /** The agent's name for the Scenario button (`data-surface-target`). */
  scenarioTarget?: string;
  /** The result of the run; it opens the results. Null before a result. */
  summary: React.ReactNode | null;
  summaryType?: "button";
  /** An error of the run, under the summary. */
  alert?: React.ReactNode;
  scenario: React.ReactNode;
  results: React.ReactNode;
  graph: RecipeGraphSource;
  planned?: (build: AnimationPlanBuilder) => void;
  /** The run has not started, or a seek returned it to its prepared state. */
  prepared: boolean;
  outcome: "completed" | "failed" | null;
  footer: Pick<
    FooterProps,
    "horizonS" | "control" | "actions" | "after" | "labels"
  >;
}>;

/**
 * The shell of a recipe workspace: the scene and the workflow surfaces, the
 * toolbar, the detail drawer and the run footer.
 */
export function RecipeWorkspaceLayout(props: LayoutProps): React.ReactNode {
  const { view, change, status } = props;
  const { surface, panel } = view;

  function togglePanel(next: RecipePanel): void {
    change({ ...view, panel: panel === next ? null : next });
  }

  return (
    <section
      className="production-workspace persistent-production"
      data-surface={surface}
      aria-label="Persistent production"
      data-lifecycle={
        status === "running" || status === "loading" ? "running" : "settled"
      }
    >
      <div className="factory-main-canvas" hidden={surface === "workflow"}>
        {props.animation !== undefined && (
          <RecipeAnimationNotice plan={props.animation} clock={props.clock} />
        )}
        {props.scene}
      </div>
      <header className="factory-toolbar">
        <RecipeBackButton close={props.close} />
        <div className="factory-title">
          <h2>{props.title}</h2>
        </div>
        <nav aria-label="Factory workspace">
          <RecipeSurfaceSwitch
            value={surface}
            select={(next) => change({ ...view, surface: next })}
          />
          <div
            className="factory-panel-pills"
            role="group"
            aria-label="Detail panels"
          >
            <button
              type="button"
              data-surface-target={props.scenarioTarget}
              aria-expanded={panel === "scenario"}
              onClick={() => togglePanel("scenario")}
            >
              Scenario
            </button>
            <button
              type="button"
              aria-expanded={panel === "results"}
              onClick={() => togglePanel("results")}
            >
              Results
            </button>
            {props.pills}
          </div>
        </nav>
      </header>
      {props.summary !== null && (
        <button
          type={props.summaryType}
          className="factory-summary"
          onClick={() => togglePanel("results")}
        >
          {props.summary}
        </button>
      )}
      {props.alert}
      <aside
        className="production-panel factory-drawer"
        aria-label="Factory details"
        hidden={panel === null}
      >
        <FactoryDrawerHeading
          title={panel === "results" ? "Results" : "Scenario"}
          close={() => change({ ...view, panel: null })}
        />
        <div hidden={panel !== "scenario"}>{props.scenario}</div>
        <div hidden={panel !== "results"}>{props.results}</div>
      </aside>
      <div className="factory-workflow-canvas" hidden={surface === "factory"}>
        <RecipeWorkflow
          planned={props.planned}
          graph={props.graph}
          stages={props.stages}
          clock={props.clock}
          running={status === "running"}
          prepared={props.prepared}
          outcome={props.outcome}
          seek={props.seek}
        />
      </div>
      <RecipeSplitDivider surface={surface} />
      <RecipeRunFooter
        clock={props.clock}
        stages={props.stages}
        horizonS={props.footer.horizonS}
        completed={props.outcome === "completed"}
        status={status}
        control={props.footer.control}
        actions={props.footer.actions}
        after={props.footer.after}
        labels={props.footer.labels}
        timeline={view.timeline}
        toggleTimeline={() => change({ ...view, timeline: !view.timeline })}
        seek={props.seek}
      />
    </section>
  );
}

/** The heading of a factory drawer: the name of its button and a close icon. */
export function FactoryDrawerHeading(
  props: Readonly<{ title: string; close(): void }>,
): React.ReactNode {
  return (
    <div className="factory-drawer-heading">
      <h3>{props.title}</h3>
      <button
        type="button"
        className="factory-drawer-close"
        aria-label="Close details"
        onClick={props.close}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The run control: start, pause, resume or run again. */
export function RecipeRunControl(
  props: Readonly<{
    status: string;
    start(): void;
    pause(): void;
    restart(): void;
    pauseLabel?: string;
  }>,
): React.ReactNode {
  switch (props.status) {
    case "running":
      return (
        <button className="factory-primary" onClick={props.pause}>
          <RunIcon action="pause" />
          {props.pauseLabel ?? "Pause production run"}
        </button>
      );
    case "paused":
      return (
        <button className="factory-primary" onClick={props.start}>
          <RunIcon action="start" />
          Resume production run
        </button>
      );
    case "completed":
    case "blocked":
      return (
        <button className="factory-primary" onClick={props.restart}>
          <RunIcon action="again" />
          Run again
        </button>
      );
    default:
      return (
        <button className="factory-primary" onClick={props.start}>
          <RunIcon action="start" />
          Start production
        </button>
      );
  }
}

/** A recipe whose model the shared playback steps. */
export type RecipeRun<Sample extends RecipeRunSample, Recipe> = Readonly<{
  model(recipe: Recipe): RecipeEngine<Sample>;
  /** The timeline stages, which an animation plan maps a draft onto. */
  stages(recipe: Recipe): FooterProps["stages"];
  /** The notice when the run ends. */
  outcomeNotice(outcome: NonNullable<Sample["outcome"]>): string;
  /** The notice after Run again. */
  resetNotice: string;
  /** The notice before the first start. */
  notice: string;
  /** The model's end of the original run, in seconds. */
  endS: number;
}>;

/** What a recipe's content reads of its run. */
export type RecipeRunView<Sample extends RecipeRunSample, Recipe> = Readonly<{
  recipe: Recipe;
  notice: string;
  frames: LiveSource<RecipeFrames<Sample>>;
  status: RecipeRunStatus;
  outcome: Sample["outcome"];
  /** Applies a scenario with its notice; `start` runs it at once. */
  apply(next: Recipe, notice: string, start?: boolean): void;
}>;

/** The parts of the workspace that each recipe fills. */
export type RecipeContent = Readonly<{
  title: React.ReactNode;
  scene: React.ReactNode;
  summary: React.ReactNode | null;
  scenario: React.ReactNode;
  results: React.ReactNode;
  graph: RecipeGraphSource;
  actions?: React.ReactNode;
}>;

type PlaybackProps<Sample extends RecipeRunSample, Recipe> = Readonly<{
  recipe: Recipe;
  close(): void;
  run: RecipeRun<Sample, Recipe>;
  content(run: RecipeRunView<Sample, Recipe>): RecipeContent;
}>;

type PlaybackState<Recipe> = RecipeWorkspaceView &
  RecipeRunState &
  Readonly<{ recipe: Recipe }>;

/** The workspace of a recipe that the shared playback runs, and its scenario. */
export class RecipePlaybackWorkspace<
  Sample extends RecipeRunSample,
  Recipe,
> extends React.Component<
  PlaybackProps<Sample, Recipe>,
  PlaybackState<Recipe>
> {
  private readonly playback: RecipePlayback<Sample, Recipe>;

  constructor(props: PlaybackProps<Sample, Recipe>) {
    super(props);
    const { run } = props;
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: run.model,
        stages: run.stages,
        outcomeNotice: run.outcomeNotice,
        resetNotice: run.resetNotice,
      },
      props.recipe,
    );
    this.state = {
      ...RECIPE_WORKSPACE_VIEW,
      recipe: props.recipe,
      status: "review",
      notice: run.notice,
    };
  }

  componentWillUnmount(): void {
    this.playback.stop();
  }

  private apply(next: Recipe, notice: string, start = false): void {
    this.playback.applyScenario(next);
    this.setState(
      { recipe: next, status: "review", panel: null, notice },
      start ? () => this.playback.start() : undefined,
    );
  }

  render(): React.ReactNode {
    const { recipe, status, notice } = this.state;
    const { run } = this.props;
    const { playback } = this;
    const { frames, clock, animation } = playback;
    // The outcome arrives with a status change, so this render reads it.
    const outcome = frames.get().sample.outcome;
    const content = this.props.content({
      recipe,
      notice,
      frames,
      status,
      outcome,
      apply: this.apply.bind(this),
    });
    return (
      <RecipeWorkspaceLayout
        view={this.state}
        change={(view) => this.setState(view)}
        close={this.props.close}
        status={status}
        clock={clock}
        stages={warpedStages(run.stages(recipe), animation)}
        seek={playback.scrubToTime.bind(playback)}
        animation={animation}
        scene={content.scene}
        title={content.title}
        summary={content.summary}
        scenario={content.scenario}
        results={content.results}
        graph={content.graph}
        planned={playback.planned.bind(playback)}
        prepared={status === "review"}
        outcome={outcome?.kind ?? null}
        footer={{
          horizonS: runEnd(animation, run.endS),
          control: (
            <RecipeRunControl
              status={status}
              start={playback.start.bind(playback)}
              pause={playback.pause.bind(playback)}
              restart={playback.restart.bind(playback)}
            />
          ),
          actions: content.actions,
        }}
      />
    );
  }
}
